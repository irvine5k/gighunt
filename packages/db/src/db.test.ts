import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GigDatabase } from './index.js';

describe('GigDatabase', () => {
  function prepared(db: GigDatabase, safeForAutomatic = false) {
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: ['Engineer'], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/job', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/job', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'https://acme.test/team/rae', emailEvidence: 'Hunter verification: valid' });
    return { draft: db.createDraft(job.id, contact.id, 'Hello', 'Message', safeForAutomatic), job, contact };
  }
  it('deduplicates logical tasks and reclaims expired leases', () => {
    const db = new GigDatabase();
    expect(db.enqueue('same', 'search', { n: 1 })).toBe(db.enqueue('same', 'search', { n: 2 }));
    const first = db.claim('worker-a', -1)!;
    const reclaimed = db.claim('worker-b')!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.attempts).toBe(2);
    db.close();
  });

  it('reserves paid contact attempts atomically across database connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-contact-')); const filename = join(directory, 'test.db');
    const first = new GigDatabase(filename); const second = new GigDatabase(filename);
    first.updateSettings({ enrichmentsPerRun: 1 });
    const run = first.createRun('engineer');
    const searchTask = first.claim('setup')!; first.completeTask(searchTask.id, 'setup');
    const jobA = first.upsertJob(run.id, { canonicalUrl: 'https://example.com/a', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/a', retrievedAt: new Date().toISOString() });
    const jobB = first.upsertJob(run.id, { canonicalUrl: 'https://example.com/b', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/b', retrievedAt: new Date().toISOString() });
    const taskId = first.enqueueContactResearch(jobA.id);
    expect(second.enqueueContactResearch(jobA.id)).toBe(taskId);
    first.enqueueContactResearch(jobB.id);
    const claimedA = first.claim('worker-a')!; const claimedB = second.claim('worker-b')!;
    first.reserveContactAttempt(jobA.id, claimedA.id, 'worker-a', claimedA.generation, claimedA.attempts);
    expect(() => second.reserveContactAttempt(jobB.id, claimedB.id, 'worker-b', claimedB.generation, claimedB.attempts)).toThrow('limit reached');
    expect(second.contactAttemptsForRun(run.id)).toBe(1);
    expect(() => first.reserveContactAttempt(jobA.id, claimedA.id, 'worker-a', claimedA.generation, claimedA.attempts)).toThrow('already reserved');
    first.completeTask(claimedA.id, 'worker-a');
    expect(() => second.enqueueContactResearch(jobA.id)).toThrow('limit reached');
    second.close(); first.close(); rmSync(directory, { recursive: true, force: true });
  });

  it('backfills run history and charges a rediscovered job to its current run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-rediscovery-')); const filename = join(directory, 'test.db');
    let db = new GigDatabase(filename); db.updateSettings({ enrichmentsPerRun: 1 });
    const firstRun = db.createRun('engineer'); const firstSearch = db.claim('setup')!; db.completeTask(firstSearch.id, 'setup');
    const firstJob = db.upsertJob(firstRun.id, { canonicalUrl: 'https://example.com/opening', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Old', status: 'open', score: 40, rationale: 'old match', sourceUrl: 'https://example.com/source-one', retrievedAt: '2026-01-01T00:00:00.000Z' });
    const contactTaskId = db.enqueueContactResearch(firstJob.id);
    const firstContactTask = db.claim('worker')!;
    db.reserveContactAttempt(firstJob.id, firstContactTask.id, 'worker', firstContactTask.generation, firstContactTask.attempts);
    db.completeTask(firstContactTask.id, 'worker');
    db.raw.exec(`DROP TABLE job_runs;
      CREATE TABLE job_runs (job_id TEXT NOT NULL REFERENCES jobs(id), run_id TEXT NOT NULL REFERENCES runs(id),
        score REAL NOT NULL, rationale TEXT NOT NULL, source_url TEXT NOT NULL, retrieved_at TEXT NOT NULL,
        PRIMARY KEY(job_id,run_id));
      INSERT INTO job_runs SELECT id,run_id,score,rationale,source_url,retrieved_at FROM jobs;`); // previous partial snapshot schema
    db.close(); db = new GigDatabase(filename);
    expect(db.listJobs(firstRun.id).map((job) => job.id)).toEqual([firstJob.id]);

    const secondRun = db.createRun('remote engineer'); const secondSearch = db.claim('setup')!; db.completeTask(secondSearch.id, 'setup');
    const rediscovered = db.upsertJob(secondRun.id, { canonicalUrl: firstJob.canonicalUrl, title: 'Senior Engineer', company: 'NewCo', location: 'New York', description: 'New', status: 'open', score: 90, rationale: 'new match', sourceUrl: 'https://example.com/source-two', retrievedAt: '2026-02-01T00:00:00.000Z' });
    expect(rediscovered.id).toBe(firstJob.id); expect(rediscovered.runId).toBe(secondRun.id);
    expect(db.listJobs(firstRun.id)[0]).toMatchObject({ id: firstJob.id, runId: firstRun.id, title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Old', score: 40, rationale: 'old match', sourceUrl: 'https://example.com/source-one' });
    expect(db.listJobs(secondRun.id)[0]).toMatchObject({ id: firstJob.id, runId: secondRun.id, title: 'Senior Engineer', company: 'NewCo', location: 'New York', description: 'New', score: 90, rationale: 'new match', sourceUrl: 'https://example.com/source-two' });
    expect(db.raw.prepare('SELECT url FROM job_sources WHERE job_id=? ORDER BY url').all(firstJob.id)).toEqual([{ url: 'https://example.com/source-one' }, { url: 'https://example.com/source-two' }]);
    expect(db.enqueueContactResearch(firstJob.id)).toBe(contactTaskId);
    const secondContactTask = db.claim('worker')!;
    db.reserveContactAttempt(firstJob.id, secondContactTask.id, 'worker', secondContactTask.generation, secondContactTask.attempts);
    expect(db.contactAttemptsForRun(firstRun.id)).toBe(1); expect(db.contactAttemptsForRun(secondRun.id)).toBe(1);
    db.upsertJob(firstRun.id, { canonicalUrl: firstJob.canonicalUrl, title: 'Late old result', company: 'Acme', location: 'Remote', description: 'Stale', status: 'open', score: 45, rationale: 'late old match', sourceUrl: 'https://example.com/late-source', retrievedAt: '2026-01-02T00:00:00.000Z' });
    expect(db.getJob(firstJob.id)?.runId).toBe(secondRun.id);
    expect(db.listJobs(firstRun.id)[0]?.rationale).toBe('old match');
    expect(db.listJobs(secondRun.id)[0]?.rationale).toBe('new match');
    db.close(); rmSync(directory, { recursive: true, force: true });
  });

  it('invalidates old approvals and prevents duplicate outreach', () => {
    const db = new GigDatabase();
    db.saveProfile({ id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: [], targetRoles: [], locations: [], remote: true, confirmed: true });
    const run = db.createRun('engineer');
    const job = db.upsertJob(run.id, { canonicalUrl: 'https://example.com/job', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'Build', status: 'open', score: 50, rationale: 'match', sourceUrl: 'https://example.com/job', retrievedAt: new Date().toISOString() });
    const contact = db.saveContact(job.id, { name: 'Rae', email: 'rae@acme.test', role: 'Recruiter', verified: true, affiliationEvidence: 'company page', emailEvidence: 'Hunter verified' });
    const oldDraft = db.createDraft(job.id, contact.id, 'Hello', 'Old');
    db.approve(oldDraft.id, 'individual');
    const newDraft = db.createDraft(job.id, contact.id, 'Hello', 'New');
    expect(() => db.reserveSend(oldDraft.id)).toThrow('details changed');
    db.approve(newDraft.id, 'individual');
    db.reserveSend(newDraft.id);
    expect(() => db.reserveSend(newDraft.id)).toThrow('already exists');
    db.close();
  });

  it('requires a constrained safe draft for automatic outreach', () => {
    const db = new GigDatabase(); db.updateSettings({ approvalMode: 'automatic' });
    const unsafe = prepared(db).draft;
    expect(() => db.reserveSend(unsafe.id)).toThrow('not approved');
    const safe = db.createDraft(unsafe.jobId, unsafe.contactId, 'Safe', 'Safe body', true);
    expect(() => db.reserveSend(safe.id)).toThrow('not approved');
    db.confirmContactAffiliation(safe.contactId);
    expect(db.reserveSend(safe.id).status).toBe('reserved');
    db.close();
  });

  it('revokes recruiter confirmation and stale drafts when job claims change', () => {
    const db = new GigDatabase(); db.updateSettings({ approvalMode: 'automatic' });
    const { draft, job, contact } = prepared(db, true);
    db.confirmContactAffiliation(contact.id); db.approve(draft.id, 'individual');
    const newerRun = db.createRun('new opening');
    db.upsertJob(newerRun.id, { canonicalUrl: job.canonicalUrl, title: 'Staff Engineer', company: 'NewCo', location: 'Remote', description: 'Different team', status: 'open', score: 80, rationale: 'new match', sourceUrl: job.sourceUrl, retrievedAt: new Date().toISOString() });
    expect(db.getContact(contact.id)?.affiliationConfirmed).toBe(false);
    expect(() => db.confirmContactAffiliation(contact.id)).toThrow('research this contact again');
    expect(() => db.approve(draft.id, 'individual')).toThrow('details changed');
    expect(() => db.reserveSend(draft.id)).toThrow('details changed');
    expect(db.raw.prepare('SELECT invalidated_at FROM approvals WHERE draft_id=?').get(draft.id)).toMatchObject({ invalidated_at: expect.any(String) });

    db.saveContact(job.id, { name: 'Rae', email: contact.email, role: 'Recruiter', verified: true, affiliationEvidence: 'https://newco.test/team/rae', emailEvidence: 'Hunter verification: valid' });
    db.confirmContactAffiliation(contact.id);
    expect(() => db.reserveSend(draft.id)).toThrow('details changed');
    const fresh = db.createDraft(job.id, contact.id, 'Staff role', 'Fresh details', true);
    expect(db.reserveSend(fresh.id).status).toBe('reserved');
    db.close();
  });

  it('requires a fresh draft when recruiter evidence changes', () => {
    const db = new GigDatabase(); db.updateSettings({ approvalMode: 'automatic' });
    const { draft, job, contact } = prepared(db, true);
    db.confirmContactAffiliation(contact.id);
    db.saveContact(job.id, { name: 'Rae Updated', email: contact.email, role: 'Recruiter', verified: true, affiliationEvidence: 'https://acme.test/new-team', emailEvidence: 'New verification' });
    expect(db.getContact(contact.id)?.affiliationConfirmed).toBe(false);
    db.confirmContactAffiliation(contact.id);
    expect(() => db.reserveSend(draft.id)).toThrow('details changed');
    const fresh = db.createDraft(job.id, contact.id, 'Fresh', 'Fresh body', true);
    expect(db.reserveSend(fresh.id).status).toBe('reserved');
    db.close();
  });

  it('requires renewed approvals and affiliation review when upgrading an older database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-upgrade-')); const filename = join(directory, 'test.db');
    let db = new GigDatabase(filename); const { draft, contact } = prepared(db);
    db.confirmContactAffiliation(contact.id); db.approve(draft.id, 'individual');
    db.raw.prepare("DELETE FROM migration_versions WHERE version='trust-revisions-v1'").run(); // interruption after schema change, before trust revocation
    db.close(); db = new GigDatabase(filename);
    expect(db.getContact(contact.id)?.affiliationConfirmed).toBe(false);
    expect(db.raw.prepare('SELECT invalidated_at FROM approvals WHERE draft_id=?').get(draft.id)).toMatchObject({ invalidated_at: expect.any(String) });
    expect(() => db.reserveSend(draft.id)).toThrow('not approved');
    db.close(); rmSync(directory, { recursive: true, force: true });
  });

  it('rolls back schema changes if trust revocation fails mid-migration, then safely retries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-migration-crash-')); const filename = join(directory, 'test.db');
    let db = new GigDatabase(filename); const { draft, contact } = prepared(db);
    db.confirmContactAffiliation(contact.id); db.approve(draft.id, 'individual');
    db.raw.exec(`DELETE FROM migration_versions WHERE version='trust-revisions-v1';
      ALTER TABLE sends DROP COLUMN replaceable;
      CREATE TRIGGER interrupt_trust_update BEFORE UPDATE OF invalidated_at ON approvals
      BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;`);
    db.close();
    expect(() => new GigDatabase(filename)).toThrow('synthetic migration failure');
    const raw = new Database(filename);
    expect((raw.prepare('PRAGMA table_info(sends)').all() as Array<{ name: string }>).some((column) => column.name === 'replaceable')).toBe(false);
    expect(raw.prepare("SELECT 1 FROM migration_versions WHERE version='trust-revisions-v1'").get()).toBeUndefined();
    raw.exec('DROP TRIGGER interrupt_trust_update'); raw.close();
    db = new GigDatabase(filename);
    expect(db.getContact(contact.id)?.affiliationConfirmed).toBe(false);
    expect(db.raw.prepare('SELECT invalidated_at FROM approvals WHERE draft_id=?').get(draft.id)).toMatchObject({ invalidated_at: expect.any(String) });
    expect((db.raw.prepare('PRAGMA table_info(sends)').all() as Array<{ name: string }>).some((column) => column.name === 'replaceable')).toBe(true);
    db.close(); rmSync(directory, { recursive: true, force: true });
  });

  it('approves exact revisions together only in batch mode', () => {
    const db = new GigDatabase(); const { draft } = prepared(db);
    expect(() => db.approveBatch([draft.id])).toThrow('batch mode');
    db.updateSettings({ approvalMode: 'batch' });
    expect(db.approveBatch([draft.id])).toHaveLength(1);
    expect(db.reserveSend(draft.id).status).toBe('reserved'); db.close();
  });

  it('atomically enters dispatching once and recovers a crash as uncertain', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-db-')); const filename = join(directory, 'test.db');
    let db = new GigDatabase(filename); const { draft } = prepared(db); db.approve(draft.id, 'individual');
    const send = db.reserveSend(draft.id); const taskId = db.enqueue(`send:${send.id}`, 'send', { sendId: send.id });
    const searchTask = db.claim('worker-a')!; db.completeTask(searchTask.id, 'worker-a');
    const task = db.claim('worker-a')!;
    expect(task.id).toBe(taskId);
    expect(db.beginDispatch(send.id, task.id, 'worker-a')?.send.status).toBe('dispatching');
    expect(() => db.beginDispatch(send.id, task.id, 'worker-a')).toThrow('not reserved');
    db.close(); db = new GigDatabase(filename);
    expect(db.getSend(send.id)?.status).toBe('uncertain');
    expect(db.claim('worker-b')).toBeNull();
    db.close(); rmSync(directory, { recursive: true, force: true });
  });

  it('cancels a stale reserved send before transport and archives it when a corrected draft is reserved', () => {
    const db = new GigDatabase(); const { draft, job, contact } = prepared(db);
    db.approve(draft.id, 'individual'); const first = db.reserveSend(draft.id);
    db.enqueue(`send:${first.id}`, 'send', { sendId: first.id });
    const search = db.claim('worker')!; db.completeTask(search.id, 'worker');
    const task = db.claim('worker')!;
    db.saveContact(job.id, { name: 'Rae Updated', email: contact.email, role: 'Recruiter', verified: true, affiliationEvidence: 'new company page', emailEvidence: 'valid' });
    expect(db.beginDispatch(first.id, task.id, 'worker')).toBeNull();
    expect(db.getSend(first.id)?.status).toBe('cancelled');
    expect(db.raw.prepare('SELECT replaceable FROM sends WHERE id=?').get(first.id)).toEqual({ replaceable: 1 });
    const corrected = db.createDraft(job.id, contact.id, 'Corrected', 'Current claims');
    db.approve(corrected.id, 'individual'); const second = db.reserveSend(corrected.id);
    expect(second.id).not.toBe(first.id);
    expect(db.listSends().map((send) => send.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(() => db.reserveSend(corrected.id)).toThrow('already exists');
    db.close();
  });

  it('replaces stale queued outreach before a worker claims it, even at the daily reservation limit', () => {
    const db = new GigDatabase(); db.updateSettings({ dailySendLimit: 1 });
    const { draft, job, contact } = prepared(db); db.approve(draft.id, 'individual');
    const first = db.reserveSend(draft.id);
    const taskId = db.enqueue(`send:${first.id}`, 'send', { sendId: first.id });
    db.saveContact(job.id, { name: 'Rae Updated', email: contact.email, role: 'Recruiter', verified: true, affiliationEvidence: 'new company page', emailEvidence: 'valid' });
    const corrected = db.createDraft(job.id, contact.id, 'Corrected', 'Current claims'); db.approve(corrected.id, 'individual');
    const second = db.reserveSend(corrected.id);
    expect(second.status).toBe('reserved');
    expect(db.raw.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(taskId)).toEqual({ status: 'completed' });
    expect(db.listSends().find((send) => send.id === first.id)?.status).toBe('cancelled');
    db.close();
  });

  it('replaces a queued send whose draft was edited before transport', () => {
    const db = new GigDatabase(); const { draft, job, contact } = prepared(db);
    db.approve(draft.id, 'individual'); const first = db.reserveSend(draft.id);
    db.enqueue(`send:${first.id}`, 'send', { sendId: first.id });
    const revised = db.createDraft(job.id, contact.id, 'Revised', 'Current body');
    expect(() => db.approve(draft.id, 'individual')).toThrow('details changed');
    db.approve(revised.id, 'individual');
    const second = db.reserveSend(revised.id);
    expect(second.id).not.toBe(first.id);
    expect(db.listSends().find((send) => send.id === first.id)?.status).toBe('cancelled');
    db.close();
  });

  it('never replaces uncertain or sent outreach even after reconciliation', () => {
    for (const status of ['uncertain', 'sent'] as const) {
      const db = new GigDatabase(); const { draft, job, contact } = prepared(db);
      db.approve(draft.id, 'individual'); const send = db.reserveSend(draft.id);
      db.updateSend(send.id, status, status === 'sent' ? 'gmail-id' : null, null);
      if (status === 'uncertain') db.updateSend(send.id, 'cancelled', null, 'Manually confirmed not sent');
      const corrected = db.createDraft(job.id, contact.id, 'Corrected', 'New body');
      db.approve(corrected.id, 'individual');
      expect(() => db.reserveSend(corrected.id)).toThrow('already exists');
      db.close();
    }
  });
});
