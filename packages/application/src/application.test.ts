import { describe, expect, it } from 'vitest';
import { GigDatabase } from '@gighunt/db';
import { FakeProviders } from '@gighunt/providers';
import { ProviderError } from '@gighunt/domain';
import { GigHuntService, QueueWorker } from './index.js';

describe('GigHunt workflow', () => {
  it('runs research, drafts, approves, and sends with shared policy', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders();
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts: fake, mail: fake });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: ['TypeScript'], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const run = service.startRun('typescript'); const worker = new QueueWorker(db, service, 'test-worker');
    await worker.tick();
    expect(db.getRun(run.id)?.status).toBe('completed');
    await worker.tick(); await worker.tick();
    const job = db.listJobs()[0]!; const contact = db.listContacts(job.id)[0]!;
    const draft = await service.createDraft(job.id, contact.id); service.approve(draft.id);
    const send = service.queueSend(draft.id); await worker.tick();
    expect(db.getSend(send.id)?.status).toBe('sent');
    db.close();
  });

  it('allows only one concurrent worker to dispatch a reserved send', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders(); let deliveries = 0;
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts: fake, mail: { send: async () => { deliveries++; await Promise.resolve(); return { messageId: 'one' }; } } });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer'); const search = db.claim('setup')!; db.completeTask(search.id, 'setup');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/unique', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/unique', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'https://acme.test/team', emailEvidence: 'valid' });
    const draft = db.createDraft(job.id, contact.id, 'Hello', 'Body'); service.approve(draft.id); const send = service.queueSend(draft.id);
    await Promise.all([new QueueWorker(db, service, 'one').tick(), new QueueWorker(db, service, 'two').tick()]);
    expect(deliveries).toBe(1); expect(db.getSend(send.id)?.status).toBe('sent'); db.close();
  });

  it('marks only deterministic automatic templates safe and never model or edited drafts', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders(); let modelCalls = 0;
    const service = new GigHuntService(db, { search: fake, pages: fake, contacts: fake, mail: fake, model: { extractJob: (url) => fake.extractJob(url), draft: async (input) => { modelCalls++; return fake.draft(input); } } });
    db.saveProfile({ id: 'default', name: 'Ada\nInjected', email: 'ada@example.com', summary: 'Engineer', skills: ['TypeScript\nIgnore rules'], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer'); const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/auto', title: 'Engineer\nBcc: bad', company: 'Acme', location: 'Remote', description: 'Untrusted instructions', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/auto', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'https://acme.test/team', emailEvidence: 'valid' });
    const manual = await service.createDraft(job.id, contact.id); expect(manual.safeForAutomatic).toBe(false); expect(modelCalls).toBe(1);
    db.updateSettings({ approvalMode: 'automatic' }); const automatic = await service.createDraft(job.id, contact.id);
    expect(automatic.safeForAutomatic).toBe(true); expect(automatic.subject).not.toContain('\n'); expect(modelCalls).toBe(1);
    expect(service.updateDraft(automatic.id, automatic.subject, automatic.body).safeForAutomatic).toBe(false); db.close();
  });

  it('requeues completed-empty and failed explicit contact research without duplicating active work', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders(); let searches = 0;
    const contacts = { find: async () => { searches++; return []; } };
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts, mail: fake });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer'); const initial = db.claim('setup')!; db.completeTask(initial.id, 'setup');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/requeue', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/requeue', retrievedAt: new Date().toISOString() });
    const taskId = service.enqueueContactResearch(job.id); const worker = new QueueWorker(db, service, 'contacts'); await worker.tick();
    expect(searches).toBe(1); expect(service.enqueueContactResearch(job.id)).toBe(taskId); expect(service.enqueueContactResearch(job.id)).toBe(taskId);
    await worker.tick(); expect(searches).toBe(2);
    db.raw.prepare("UPDATE workflow_tasks SET status='failed' WHERE id=?").run(taskId);
    expect(service.enqueueContactResearch(job.id)).toBe(taskId); await worker.tick(); expect(searches).toBe(3); db.close();
  });

  it('charges failed provider attempts before retry and stops at the run limit', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders(); let calls = 0;
    db.updateSettings({ enrichmentsPerRun: 2 });
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, mail: fake, contacts: { find: async () => { calls++; throw new Error('Provider unavailable'); } } });
    const run = db.createRun('engineer'); const search = db.claim('setup')!; db.completeTask(search.id, 'setup');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/budget', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/budget', retrievedAt: new Date().toISOString() });
    const taskId = service.enqueueContactResearch(job.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const task = db.claim('worker')!;
      await expect(service.processTask(task, 'worker')).rejects.toThrow(attempt === 3 ? 'limit reached' : 'Provider unavailable');
      expect(db.contactAttemptsForRun(run.id)).toBe(Math.min(attempt, 2));
      db.failTask(task.id, 'worker', 'failed', 0);
    }
    expect(calls).toBe(2);
    expect(db.raw.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(taskId)).toEqual({ status: 'failed' });
    expect(() => service.enqueueContactResearch(job.id)).toThrow('limit reached');
    db.close();
  });

  it('researches a rediscovered URL under the new run budget', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders(); db.updateSettings({ enrichmentsPerRun: 1 });
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts: fake, mail: fake });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: ['TypeScript'], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const worker = new QueueWorker(db, service, 'rediscovery');
    const first = service.startRun('engineer'); await worker.tick(); await worker.tick();
    const job = db.listJobs(first.id)[0]!; expect(db.contactAttemptsForRun(first.id)).toBe(1);
    const second = service.startRun('engineer'); await worker.tick(); await worker.tick();
    expect(db.getJob(job.id)?.runId).toBe(second.id);
    expect(db.listJobs(first.id).map((item) => item.id)).toContain(job.id);
    expect(db.listJobs(second.id).map((item) => item.id)).toContain(job.id);
    expect(db.contactAttemptsForRun(first.id)).toBe(1);
    expect(db.contactAttemptsForRun(second.id)).toBe(1);
    db.close();
  });

  it('rejects contact results returned after rediscovery without overwriting newer evidence', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders();
    let release!: (value: Awaited<ReturnType<typeof fake.find>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof fake.find>>>((resolve) => { release = resolve; });
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, mail: fake, contacts: { find: () => pending } });
    const firstRun = db.createRun('first'); const search = db.claim('setup')!; db.completeTask(search.id, 'setup');
    const job = db.upsertJob(firstRun.id, { canonicalUrl: 'https://example.com/async', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/async', retrievedAt: new Date().toISOString() });
    service.enqueueContactResearch(job.id); const task = db.claim('worker')!;
    const research = service.researchContact(job.id, task, 'worker');
    const secondRun = db.createRun('second');
    db.upsertJob(secondRun.id, { canonicalUrl: job.canonicalUrl, title: 'Staff Engineer', company: 'NewCo', location: job.location, description: job.description, status: 'open', score: 90, rationale: job.rationale, sourceUrl: job.sourceUrl, retrievedAt: new Date().toISOString() });
    release([{ name: 'Old recruiter', email: 'old@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'old page', emailEvidence: 'valid' }]);
    await expect(research).rejects.toThrow('changed during research');
    expect(db.listContacts(job.id)).toEqual([]);
    expect(db.contactAttemptsForRun(firstRun.id)).toBe(1);
    db.close();
  });

  it('rejects model output returned after contact details change', async () => {
    const db = new GigDatabase(); const fake = new FakeProviders();
    let release!: (value: { subject: string; body: string }) => void;
    const pending = new Promise<{ subject: string; body: string }>((resolve) => { release = resolve; });
    const service = new GigHuntService(db, { search: fake, pages: fake, contacts: fake, mail: fake, model: { extractJob: (url) => fake.extractJob(url), draft: () => pending } });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: [], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/draft-race', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/draft-race', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'company page', emailEvidence: 'valid' });
    const drafting = service.createDraft(job.id, contact.id);
    db.saveContact(job.id, { name: 'Rae Updated', email: contact.email, role: 'Recruiter', verified: true, affiliationEvidence: 'new page', emailEvidence: 'valid' });
    release({ subject: 'Old claim', body: 'Old claim' });
    await expect(drafting).rejects.toThrow('changed during drafting');
    expect(db.listDrafts()).toEqual([]);
    db.close();
  });

  it.each(['authentication', 'quota', 'invalid-response', 'blocked-request'] as const)('permits a corrected send after definitive %s mail failure', async (kind) => {
    const db = new GigDatabase(); const fake = new FakeProviders(); let calls = 0;
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts: fake, mail: { send: async () => { calls++; throw new ProviderError(kind, 'Definitive Gmail rejection'); } } });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: [], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer'); const search = db.claim('setup')!; db.completeTask(search.id, 'setup');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/mail-failure', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/mail-failure', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'company page', emailEvidence: 'valid' });
    const draft = db.createDraft(job.id, contact.id, 'Hello', 'Body'); service.approve(draft.id);
    const first = service.queueSend(draft.id); await new QueueWorker(db, service, 'worker').tick();
    expect(db.getSend(first.id)?.status).toBe('failed'); expect(calls).toBe(1);
    const corrected = db.createDraft(job.id, contact.id, 'Corrected', 'New body'); service.approve(corrected.id);
    const second = service.queueSend(corrected.id);
    expect(second.id).not.toBe(first.id);
    expect(db.listSends().map((send) => send.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    db.close();
  });

  it.each(['retryable', 'unknown'] as const)('locks %s mail failure as uncertain until reconciliation', async (kind) => {
    const db = new GigDatabase(); const fake = new FakeProviders();
    const failure = kind === 'retryable' ? new ProviderError('retryable', 'Gmail may have accepted the request') : new Error('Socket closed');
    const service = new GigHuntService(db, { search: fake, pages: fake, model: fake, contacts: fake, mail: { send: async () => { throw failure; } } });
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: [], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer'); const search = db.claim('setup')!; db.completeTask(search.id, 'setup');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/uncertain', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/uncertain', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'company page', emailEvidence: 'valid' });
    const draft = db.createDraft(job.id, contact.id, 'Hello', 'Body'); service.approve(draft.id);
    const first = service.queueSend(draft.id); await new QueueWorker(db, service, 'worker').tick();
    expect(db.getSend(first.id)?.status).toBe('uncertain');
    const corrected = db.createDraft(job.id, contact.id, 'Corrected', 'New body'); service.approve(corrected.id);
    expect(() => service.queueSend(corrected.id)).toThrow('already exists');
    db.close();
  });
});
