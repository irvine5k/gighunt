import { describe, expect, it } from 'vitest';
import { GigDatabase } from '@gighunt/db';
import { createServer, runScheduledTick } from './server.js';
import { secretWriteCommand } from './secrets.js';

describe('daemon security and workflow', () => {
  it('passes macOS keychain secret values on stdin rather than argv', () => {
    const command = secretWriteCommand('OPENAI_API_KEY', 'darwin')!;
    expect(command.args.at(-1)).toBe('-w');
    expect(command.args.join(' ')).not.toContain('secret-value');
  });
  it('requires authentication and rejects hostile origins', async () => {
    const db = new GigDatabase(); const { app } = await createServer({ database: db, apiToken: 'secret', mcpToken: 'mcp-secret', fakeProviders: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { authorization: 'Bearer secret', origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { authorization: 'Bearer secret' } })).statusCode).toBe(200);
    await app.close(); db.close();
  });

  it('supports one-time browser bootstrap and CSRF', async () => {
    const db = new GigDatabase(); const server = await createServer({ database: db, apiToken: 'secret', fakeProviders: true });
    const nonce = server.bootstrapNonce();
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: { nonce } });
    expect(response.statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: { nonce } })).statusCode).toBe(401);
    await server.app.close(); db.close();
  });

  it('validates REST inputs and blocks MCP approval', async () => {
    const db = new GigDatabase(); const { app } = await createServer({ database: db, apiToken: 'secret', mcpToken: 'mcp-secret', fakeProviders: true });
    const headers = { authorization: 'Bearer secret' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/runs', headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/schedule', headers, payload: { enabled: true, cron: 'bad cron', timezone: 'Mars/Olympus', lastRunAt: null } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/outreach/approve', headers: { authorization: 'Bearer mcp-secret' }, payload: { draftId: 'draft' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: { authorization: 'Bearer mcp-secret' }, payload: { approvalMode: 'automatic' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/providers', headers: { authorization: 'Bearer mcp-secret' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/profile', headers: { authorization: 'Bearer mcp-secret' }, payload: { name: 'Ada', email: 'ada@example.com', summary: '', skills: [], targetRoles: [], locations: [], remote: true, confirmed: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/outreach/send-id/reconcile', headers: { authorization: 'Bearer mcp-secret' }, payload: { outcome: 'cancelled' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/contacts/contact-id/confirm-affiliation', headers: { authorization: 'Bearer mcp-secret' }, payload: { confirmed: true } })).statusCode).toBe(403);
    await app.close(); db.close();
  });

  it('lets MCP read researched contacts and their evidence without granting approval', async () => {
    const db = new GigDatabase(); const run = db.createRun('engineer');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/contact', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/contact', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'https://acme.test/team', emailEvidence: 'Published address' });
    const { app } = await createServer({ database: db, apiToken: 'secret', mcpToken: 'mcp-secret', fakeProviders: true });
    const headers = { authorization: 'Bearer mcp-secret' };
    const list = await app.inject({ method: 'GET', url: `/api/v1/contacts?jobId=${job.id}`, headers });
    expect(list.statusCode).toBe(200); expect(list.json()).toEqual([expect.objectContaining({ id: contact.id, affiliationEvidence: 'https://acme.test/team' })]);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contact.id}`, headers });
    expect(detail.statusCode).toBe(200); expect(detail.json().id).toBe(contact.id);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/contacts/${contact.id}/confirm-affiliation`, headers, payload: { confirmed: true } })).statusCode).toBe(403);
    await app.close(); db.close();
  });

  it('does not advance a schedule until an eligible profile is atomically queued', () => {
    const db = new GigDatabase(); db.updateSchedule({ enabled: true, cron: '* * * * *', timezone: 'UTC', lastRunAt: null });
    expect(runScheduledTick(db, new Date('2026-01-01T00:01:30Z'))).toBeNull();
    expect(db.getSchedule().lastRunAt).toBeNull();
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    expect(runScheduledTick(db, new Date('2026-01-01T00:01:30Z'))).not.toBeNull();
    expect(db.getSchedule().lastRunAt).toBe('2026-01-01T00:01:30.000Z');
    db.close();
  });
});
