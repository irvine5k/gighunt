import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { Cron } from 'croner';
import { GigDatabase } from '@gighunt/db';
import { GigHuntService, QueueWorker } from '@gighunt/application';
import { BraveSearchProvider, FakeProviders, GmailProvider, HunterContactProvider, OpenAiModelProvider, SafePageFetcher } from '@gighunt/providers';
import { AffiliationConfirmationInput, ApprovalInput, BatchApprovalInput, BootstrapInput, ContactsQuery, DraftCreateInput, DraftUpdateInput, EmptyInput, EventsQuery, IdParams, JobsQuery, ProfileInput, ReconcileInput, RunInput, ScheduleInput, SettingsInput } from '@gighunt/contracts';
import { hasSecret, loadSecret, saveSecret } from './secrets.js';

export interface ServerOptions { database?: GigDatabase; apiToken?: string; mcpToken?: string; fakeProviders?: boolean; webRoot?: string }

function configDir() { return process.env.GIGHUNT_CONFIG_DIR ?? join(homedir(), '.config', 'gighunt'); }
export function tokenPath() { return join(configDir(), 'token'); }
export function loadOrCreateToken() {
  const stored = loadSecret('API_TOKEN'); if (stored) return stored;
  const path = tokenPath();
  if (existsSync(path)) { const legacy = readFileSync(path, 'utf8').trim(); if (legacy) { saveSecret('API_TOKEN', legacy); return legacy; } }
  const token = randomBytes(32).toString('base64url');
  saveSecret('API_TOKEN', token); return token;
}
export function readStoredToken() { return loadSecret('API_TOKEN'); }
export function loadOrCreateMcpToken() { const stored = loadSecret('MCP_TOKEN'); if (stored) return stored; const token = randomBytes(32).toString('base64url'); saveSecret('MCP_TOKEN', token); return token; }
export function readStoredMcpToken() { return loadSecret('MCP_TOKEN'); }
export { saveSecret } from './secrets.js';

function bearer(request: FastifyRequest) { return request.headers.authorization?.replace(/^Bearer\s+/i, ''); }

export async function createServer(options: ServerOptions = {}) {
  const app = fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 1_000_000, trustProxy: false });
  await app.register(cookie);
  if (!options.database) mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const db = options.database ?? new GigDatabase(process.env.GIGHUNT_DB ?? join(configDir(), 'gighunt.db'));
  const token = options.apiToken ?? loadOrCreateToken();
  const mcpToken = options.mcpToken ?? (options.apiToken ? randomBytes(32).toString('base64url') : loadOrCreateMcpToken());
  const fake = new FakeProviders(); const useFake = options.fakeProviders ?? process.env.GIGHUNT_FAKE_PROVIDERS === 'true';
  const service = new GigHuntService(db, useFake ? { search: fake, pages: fake, model: fake, contacts: fake, mail: fake } : {
    search: new BraveSearchProvider(loadSecret('BRAVE_API_KEY') ?? ''), pages: new SafePageFetcher(),
    model: new OpenAiModelProvider(loadSecret('OPENAI_API_KEY') ?? '', process.env.OPENAI_MODEL ?? 'gpt-5-mini'),
    contacts: new HunterContactProvider(loadSecret('HUNTER_API_KEY') ?? ''), mail: new GmailProvider({
      accessToken: loadSecret('GMAIL_ACCESS_TOKEN'), clientId: loadSecret('GMAIL_CLIENT_ID'),
      accessTokenExpiresAt: loadSecret('GMAIL_ACCESS_TOKEN_EXPIRES_AT'), clientSecret: loadSecret('GMAIL_CLIENT_SECRET'), refreshToken: loadSecret('GMAIL_REFRESH_TOKEN'),
      persistAccessToken: (accessToken, expiresAt) => { saveSecret('GMAIL_ACCESS_TOKEN', accessToken); saveSecret('GMAIL_ACCESS_TOKEN_EXPIRES_AT', expiresAt); },
    }),
  });
  const worker = new QueueWorker(db, service); const sessions = new Map<string, string>();
  let bootstrapNonce = randomBytes(24).toString('base64url');
  const scope = (request: FastifyRequest): 'human' | 'mcp' | null => {
    const session = request.cookies.gighunt_session;
    if (session && sessions.has(session)) return 'human';
    const credential = bearer(request); return credential === token ? 'human' : credential === mcpToken ? 'mcp' : null;
  };
  const mcpAllowed = (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? '';
    return [
      ['GET', /^\/api\/v1\/profile$/], ['PUT', /^\/api\/v1\/profile$/],
      ['GET', /^\/api\/v1\/runs$/], ['POST', /^\/api\/v1\/runs$/], ['GET', /^\/api\/v1\/runs\/[^/]+$/],
      ['GET', /^\/api\/v1\/jobs$/], ['GET', /^\/api\/v1\/jobs\/[^/]+$/], ['POST', /^\/api\/v1\/jobs\/[^/]+\/research-contact$/],
      ['GET', /^\/api\/v1\/contacts$/], ['GET', /^\/api\/v1\/contacts\/[^/]+$/],
      ['POST', /^\/api\/v1\/drafts$/], ['PUT', /^\/api\/v1\/drafts\/[^/]+$/],
      ['GET', /^\/api\/v1\/outreach$/], ['POST', /^\/api\/v1\/outreach\/send$/],
      ['GET', /^\/api\/v1\/schedule$/], ['PUT', /^\/api\/v1\/schedule$/],
      ['POST', /^\/api\/v1\/(pause|resume)$/],
    ].some(([method, pattern]) => request.method === method && (pattern as RegExp).test(path));
  };
  const humanOnly = (request: FastifyRequest, reply: any) => scope(request) === 'human' ? false : reply.code(403).send({ error: { code: 'HUMAN_AUTH_REQUIRED', message: 'This action requires a human CLI or dashboard credential', retryable: false } });

  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return reply.code(400).send({ error: { code: 'BAD_HOST', message: 'Host is not allowed', retryable: false } });
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) return reply.code(403).send({ error: { code: 'BAD_ORIGIN', message: 'Origin is not allowed', retryable: false } });
    if (!request.url.startsWith('/api/v1') || request.url === '/api/v1/health' || request.url.startsWith('/api/v1/auth/bootstrap')) return;
    const session = request.cookies.gighunt_session; const csrf = session ? sessions.get(session) : undefined;
    const requestScope = scope(request);
    if (!requestScope) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required', retryable: false } });
    if (requestScope === 'mcp' && !mcpAllowed(request)) return reply.code(403).send({ error: { code: 'MCP_SCOPE_DENIED', message: 'MCP credential is not authorized for this endpoint', retryable: false } });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && csrf && request.headers['x-csrf-token'] !== csrf) return reply.code(403).send({ error: { code: 'CSRF', message: 'CSRF token is invalid', retryable: false } });
  });

  app.setErrorHandler((unknownError, _request, reply) => {
    const error = unknownError instanceof Error ? unknownError : new Error('Unknown server error');
    const validation = typeof unknownError === 'object' && unknownError !== null && 'validation' in unknownError;
    const status = validation || /invalid schedule|invalid timezone/i.test(error.message) ? 400 : /not found/i.test(error.message) ? 404 : /approved|paused|limit|suppressed|already|confirmed|required|batch mode/i.test(error.message) ? 409 : 500;
    reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL' : 'POLICY', message: status === 500 ? 'Operation failed' : error.message, retryable: false } });
  });

  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/auth/bootstrap', { schema: { body: BootstrapInput } }, async (request, reply) => {
    const body = request.body as { nonce?: string };
    if (!body.nonce || body.nonce !== bootstrapNonce) return reply.code(401).send({ error: { code: 'BAD_NONCE', message: 'Bootstrap nonce is invalid', retryable: false } });
    bootstrapNonce = randomBytes(24).toString('base64url');
    const session = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url'); sessions.set(session, csrf);
    reply.setCookie('gighunt_session', session, { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
    return { csrfToken: csrf };
  });

  app.get('/api/v1/profile', async () => db.getProfile());
  app.put('/api/v1/profile', { schema: { body: ProfileInput } }, async (request, reply) => {
    const body = request.body as any; const current = db.getProfile();
    if (scope(request) === 'mcp' && (body.confirmed || current?.confirmed)) return reply.code(403).send({ error: { code: 'HUMAN_AUTH_REQUIRED', message: 'MCP may prepare only an unconfirmed profile', retryable: false } });
    return db.saveProfile({ id: 'default', ...body });
  });
  app.get('/api/v1/settings', async () => db.getSettings());
  app.patch('/api/v1/settings', { schema: { body: SettingsInput } }, async (request) => db.updateSettings(request.body as any));
  app.post('/api/v1/pause', { schema: { body: EmptyInput } }, async () => db.updateSettings({ paused: true }));
  app.post('/api/v1/resume', { schema: { body: EmptyInput } }, async () => db.updateSettings({ paused: false }));
  app.post('/api/v1/runs', { schema: { body: RunInput } }, async (request) => service.startRun((request.body as { query: string }).query));
  app.get('/api/v1/runs', async () => db.listRuns());
  app.get('/api/v1/runs/:id', { schema: { params: IdParams } }, async (request) => db.getRun((request.params as { id: string }).id));
  app.get('/api/v1/jobs', { schema: { querystring: JobsQuery } }, async (request) => db.listJobs((request.query as { runId?: string }).runId));
  app.get('/api/v1/jobs/:id', { schema: { params: IdParams } }, async (request) => db.getJob((request.params as { id: string }).id));
  app.post('/api/v1/jobs/:id/research-contact', { schema: { params: IdParams, body: EmptyInput } }, async (request) => ({ taskId: service.enqueueContactResearch((request.params as { id: string }).id) }));
  app.get('/api/v1/contacts', { schema: { querystring: ContactsQuery } }, async (request) => db.listContacts((request.query as { jobId?: string }).jobId));
  app.get('/api/v1/contacts/:id', { schema: { params: IdParams } }, async (request) => db.getContact((request.params as { id: string }).id));
  app.put('/api/v1/contacts/:id/confirm-affiliation', { schema: { params: IdParams, body: AffiliationConfirmationInput } }, async (request, reply) => {
    const denied = humanOnly(request, reply); if (denied) return denied;
    return service.confirmContactAffiliation((request.params as { id: string }).id);
  });
  app.get('/api/v1/drafts', async () => db.listDrafts());
  app.post('/api/v1/drafts', { schema: { body: DraftCreateInput } }, async (request) => { const body = request.body as { jobId: string; contactId: string }; return service.createDraft(body.jobId, body.contactId); });
  app.put('/api/v1/drafts/:id', { schema: { params: IdParams, body: DraftUpdateInput } }, async (request) => { const body = request.body as { subject: string; body: string }; return service.updateDraft((request.params as { id: string }).id, body.subject, body.body); });
  app.post('/api/v1/outreach/approve', { schema: { body: ApprovalInput } }, async (request, reply) => {
    const denied = humanOnly(request, reply); if (denied) return denied;
    return service.approve((request.body as { draftId: string }).draftId);
  });
  app.post('/api/v1/outreach/approve-batch', { schema: { body: BatchApprovalInput } }, async (request, reply) => {
    const denied = humanOnly(request, reply); if (denied) return denied;
    return service.approveBatch((request.body as { draftIds: string[] }).draftIds);
  });
  app.post('/api/v1/outreach/send', { schema: { body: ApprovalInput } }, async (request) => service.queueSend((request.body as { draftId: string }).draftId));
  app.post('/api/v1/outreach/:id/reconcile', { schema: { params: IdParams, body: ReconcileInput } }, async (request, reply) => {
    const denied = humanOnly(request, reply); if (denied) return denied;
    const body = request.body as { outcome: 'sent' | 'cancelled'; gmailMessageId?: string }; return service.reconcile((request.params as { id: string }).id, body.outcome, body.gmailMessageId);
  });
  app.get('/api/v1/outreach', async () => db.listSends());
  app.get('/api/v1/schedule', async () => db.getSchedule());
  app.put('/api/v1/schedule', { schema: { body: ScheduleInput } }, async (request) => db.updateSchedule(validateSchedule(request.body as any)));
  app.get('/api/v1/providers', async () => [
    ['OpenAI', hasSecret('OPENAI_API_KEY')], ['Brave', hasSecret('BRAVE_API_KEY')], ['Hunter', hasSecret('HUNTER_API_KEY')],
    ['Gmail', hasSecret('GMAIL_ACCESS_TOKEN') || hasSecret('GMAIL_REFRESH_TOKEN')],
  ].map(([name, configured]) => ({ name, configured: useFake || Boolean(configured), healthy: true, message: useFake ? 'Fake provider mode' : null })));
  app.get('/api/v1/events', { schema: { querystring: EventsQuery } }, async (request, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let after = Number((request.query as { after?: string }).after ?? 0);
    const emit = () => { for (const event of db.listEvents(after)) { after = event.id; reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`); } };
    emit(); const interval = setInterval(emit, 1_000); request.raw.on('close', () => clearInterval(interval));
  });

  const webRoot = options.webRoot ?? defaultWebRoot();
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  }

  const scheduleTimer = setInterval(() => { runScheduledTick(db); }, 60_000);

  app.addHook('onReady', async () => worker.start());
  app.addHook('onClose', async () => { worker.stop(); clearInterval(scheduleTimer); if (!options.database) db.close(); });
  return { app, db, service, token, bootstrapNonce: () => bootstrapNonce };
}

export function validateSchedule(schedule: { enabled: boolean; cron: string; timezone: string; lastRunAt: string | null }) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }).format(); } catch { throw new Error('Invalid timezone'); }
  try { new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }); } catch { throw new Error('Invalid schedule cron expression'); }
  return schedule;
}

export function runScheduledTick(db: GigDatabase, observedAt = new Date()) {
  try {
    const schedule = validateSchedule(db.getSchedule()); if (!schedule.enabled || db.getSettings().paused) return null;
    const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
    const previous = cron.previousRuns(1, observedAt)[0]; if (!previous) return null;
    const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (last && previous <= last) return null;
    const profile = db.getProfile(); if (!profile?.confirmed || profile.targetRoles.length === 0) return null;
    return db.createScheduledRun(profile.targetRoles.join(' OR '), observedAt.toISOString());
  } catch { return null; }
}

function defaultWebRoot() {
  const candidates = [
    fileURLToPath(new URL('../../web/dist', import.meta.url)),
    fileURLToPath(new URL('../apps/web/dist', import.meta.url)),
    join(process.cwd(), 'apps/web/dist'),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}
