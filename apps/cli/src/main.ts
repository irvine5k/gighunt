#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { GigHuntClient, type Profile, type Schedule, type Settings } from '@gighunt/contracts';
import { readStoredMcpToken, readStoredToken, saveSecret } from '@gighunt/daemon';

function token() {
  if (process.env.GIGHUNT_TOKEN) return process.env.GIGHUNT_TOKEN;
  const path = join(process.env.GIGHUNT_CONFIG_DIR ?? join(homedir(), '.config', 'gighunt'), 'token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const stored = readStoredToken();
  if (!stored) throw new Error('GigHunt token not found. Start `gighunt daemon` first.');
  return stored;
}
function mcpToken() { const value = process.env.GIGHUNT_MCP_TOKEN ?? readStoredMcpToken(); if (!value) throw new Error('GigHunt MCP token not found. Start `gighunt daemon` first.'); return value; }
function client(command: Command) { const options = command.optsWithGlobals<{ url: string }>(); return new GigHuntClient(options.url, token()); }
function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
export async function secretFromInput(input: AsyncIterable<Uint8Array | string>, isTty = false) {
  if (isTty) throw new Error('Pipe the secret on stdin, for example: printf %s "$SECRET" | gighunt secret set NAME');
  const chunks: Buffer[] = []; for await (const chunk of input) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, ''); if (!value) throw new Error('Secret stdin was empty'); return value;
}

export function buildProgram() {
  const program = new Command().name('gighunt').description('Local job research and recruiter outreach agent').option('--url <url>', 'daemon URL', process.env.GIGHUNT_URL ?? 'http://127.0.0.1:4317');
  program.command('daemon').description('start the local daemon and dashboard').action(async () => { const { createServer } = await import('@gighunt/daemon'); const { app, bootstrapNonce } = await createServer(); const url = new URL(program.opts().url); await app.listen({ host: '127.0.0.1', port: Number(url.port || 4317) }); output({ dashboard: `${url.origin}/?bootstrap=${bootstrapNonce()}` }); });
  program.command('ui').description('print the authenticated dashboard URL').action(async () => { output({ message: 'Run `gighunt daemon` and open the one-time dashboard URL it prints.' }); });
  program.command('mcp').description('start the MCP server').action(async () => { const { startMcp } = await import('@gighunt/mcp'); await startMcp({ baseUrl: program.opts().url, token: mcpToken() }); });

  const profile = program.command('profile');
  profile.command('get').action(async (_opts, command) => output(await client(command).get<Profile | null>('/profile')));
  profile.command('update').requiredOption('--json <json>').action(async (opts, command) => output(await client(command).put<Profile>('/profile', JSON.parse(opts.json))));
  const run = program.command('run');
  run.command('start').argument('<query>').action(async (query, _opts, command) => output(await client(command).post('/runs', { query })));
  run.command('list').action(async (_opts, command) => output(await client(command).get('/runs')));
  run.command('show').argument('<id>').action(async (id, _opts, command) => output(await client(command).get(`/runs/${id}`)));
  const jobs = program.command('jobs');
  jobs.command('list').action(async (_opts, command) => output(await client(command).get('/jobs')));
  jobs.command('show').argument('<id>').action(async (id, _opts, command) => output(await client(command).get(`/jobs/${id}`)));
  jobs.command('research-contact').argument('<id>').action(async (id, _opts, command) => output(await client(command).post(`/jobs/${id}/research-contact`)));
  const contacts = program.command('contacts');
  contacts.command('list').option('--job <id>', 'filter by job').action(async (opts, command) => output(await client(command).get(`/contacts${opts.job ? `?jobId=${encodeURIComponent(opts.job)}` : ''}`)));
  contacts.command('show').argument('<id>').action(async (id, _opts, command) => output(await client(command).get(`/contacts/${encodeURIComponent(id)}`)));
  const draft = program.command('draft');
  draft.command('create').requiredOption('--job <id>').requiredOption('--contact <id>').action(async (opts, command) => output(await client(command).post('/drafts', { jobId: opts.job, contactId: opts.contact })));
  draft.command('update').argument('<id>').requiredOption('--subject <text>').requiredOption('--body <text>').action(async (id, opts, command) => output(await client(command).put(`/drafts/${id}`, { subject: opts.subject, body: opts.body })));
  const outreach = program.command('outreach');
  outreach.command('approve').argument('<draftId>').action(async (draftId, _opts, command) => output(await client(command).post('/outreach/approve', { draftId })));
  outreach.command('approve-batch').argument('<draftIds...>').action(async (draftIds, _opts, command) => output(await client(command).post('/outreach/approve-batch', { draftIds })));
  outreach.command('send').argument('<draftId>').action(async (draftId, _opts, command) => output(await client(command).post('/outreach/send', { draftId })));
  outreach.command('reconcile').argument('<sendId>').requiredOption('--outcome <outcome>').option('--message-id <id>').action(async (sendId, opts, command) => output(await client(command).post(`/outreach/${sendId}/reconcile`, { outcome: opts.outcome, gmailMessageId: opts.messageId })));
  const schedule = program.command('schedule');
  schedule.command('get').action(async (_opts, command) => output(await client(command).get<Schedule>('/schedule')));
  schedule.command('update').requiredOption('--json <json>').action(async (opts, command) => output(await client(command).put<Schedule>('/schedule', JSON.parse(opts.json))));
  program.command('pause').action(async (_opts, command) => output(await client(command).post<Settings>('/pause')));
  program.command('resume').action(async (_opts, command) => output(await client(command).post<Settings>('/resume')));
  const secret = program.command('secret').description('manage provider secrets');
  secret.command('set').argument('<name>').description('read a secret from stdin and store it securely').action(async (name) => output(saveSecret(name, await secretFromInput(process.stdin, Boolean(process.stdin.isTTY)))));
  return program;
}

export function isEntrypoint(moduleUrl: string, invokedPath: string | undefined) {
  if (!invokedPath || !existsSync(invokedPath)) return false;
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
}

if (isEntrypoint(import.meta.url, process.argv[1])) buildProgram().parseAsync().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
