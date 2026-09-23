import Database from 'better-sqlite3';
import type { Contact, Draft, Job, Profile, Run, Schedule, Send, Settings } from '@gighunt/contracts';

const migration = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, summary TEXT NOT NULL,
  skills TEXT NOT NULL, target_roles TEXT NOT NULL, locations TEXT NOT NULL, remote INTEGER NOT NULL, confirmed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1), approval_mode TEXT NOT NULL, jobs_per_run INTEGER NOT NULL,
  enrichments_per_run INTEGER NOT NULL, daily_send_limit INTEGER NOT NULL, paused INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings VALUES (1,'individual',20,5,5,0);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, query TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
  status TEXT NOT NULL, score REAL NOT NULL, rationale TEXT NOT NULL, source_url TEXT NOT NULL, retrieved_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, contact_set_revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS job_runs (
  job_id TEXT NOT NULL REFERENCES jobs(id), run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  score REAL NOT NULL, rationale TEXT NOT NULL, source_url TEXT NOT NULL, retrieved_at TEXT NOT NULL,
  PRIMARY KEY(job_id,run_id)
);
CREATE INDEX IF NOT EXISTS job_runs_run ON job_runs(run_id);
CREATE TABLE IF NOT EXISTS job_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, UNIQUE(job_id,url)
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, email TEXT NOT NULL,
  normalized_email TEXT NOT NULL, role TEXT NOT NULL, verified INTEGER NOT NULL,
  affiliation_evidence TEXT, affiliation_confirmed INTEGER NOT NULL DEFAULT 0, email_evidence TEXT,
  job_revision INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(job_id,normalized_email)
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
  revision INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, safe_automatic INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  job_revision INTEGER NOT NULL DEFAULT 1, contact_revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(job_id,contact_id,revision)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id), recipient TEXT NOT NULL,
  mode TEXT NOT NULL, approved_at TEXT NOT NULL, invalidated_at TEXT
);
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id), status TEXT NOT NULL, gmail_message_id TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, replaceable INTEGER NOT NULL DEFAULT 0, UNIQUE(job_id,contact_id)
);
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_tasks_claim ON workflow_tasks(status,available_at,lease_until);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL, last_run_at TEXT
);
INSERT OR IGNORE INTO schedules VALUES (1,0,'0 9 * * *','UTC',NULL);
CREATE TABLE IF NOT EXISTS suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, provider TEXT NOT NULL, operation TEXT NOT NULL,
  units REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_attempts (
  task_id TEXT NOT NULL REFERENCES workflow_tasks(id), generation INTEGER NOT NULL, attempt INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,generation,attempt)
);
CREATE INDEX IF NOT EXISTS contact_attempts_run ON contact_attempts(run_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_history (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, contact_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  status TEXT NOT NULL, gmail_message_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL, replaceable INTEGER NOT NULL DEFAULT 0
);
`;

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const parse = <T>(value: string): T => JSON.parse(value) as T;
const staleReservedReason = 'Draft became stale before Gmail dispatch; no message was sent';

export interface Task<T = unknown> {
  id: string; logicalKey: string; type: string; payload: T; attempts: number; generation: number; maxAttempts: number;
  leaseOwner: string | null; leaseUntil: string | null;
}

export class GigDatabase {
  readonly raw: Database.Database;

  constructor(filename = ':memory:') {
    this.raw = new Database(filename);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.transaction(() => {
    this.raw.exec(migration);
    const needsTrustMigration = !this.raw.prepare("SELECT 1 FROM migration_versions WHERE version='trust-revisions-v1'").get();
    const draftColumns = this.raw.prepare('PRAGMA table_info(drafts)').all() as Array<{ name: string }>;
    if (!draftColumns.some((column) => column.name === 'safe_automatic')) this.raw.exec('ALTER TABLE drafts ADD COLUMN safe_automatic INTEGER NOT NULL DEFAULT 0');
    if (!draftColumns.some((column) => column.name === 'job_revision')) this.raw.exec('ALTER TABLE drafts ADD COLUMN job_revision INTEGER NOT NULL DEFAULT 1');
    if (!draftColumns.some((column) => column.name === 'contact_revision')) this.raw.exec('ALTER TABLE drafts ADD COLUMN contact_revision INTEGER NOT NULL DEFAULT 1');
    const jobColumns = this.raw.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
    const migratingJobRevision = !jobColumns.some((column) => column.name === 'revision');
    if (migratingJobRevision) this.raw.exec('ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (!jobColumns.some((column) => column.name === 'contact_set_revision')) this.raw.exec('ALTER TABLE jobs ADD COLUMN contact_set_revision INTEGER NOT NULL DEFAULT 1');
    const jobRunColumns = this.raw.prepare('PRAGMA table_info(job_runs)').all() as Array<{ name: string }>;
    for (const column of ['title', 'company', 'location', 'description', 'status']) {
      if (!jobRunColumns.some((entry) => entry.name === column)) {
        this.raw.exec(`ALTER TABLE job_runs ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        this.raw.prepare(`UPDATE job_runs SET ${column}=(SELECT ${column} FROM jobs WHERE jobs.id=job_runs.job_id)`).run();
      }
    }
    const contactColumns = this.raw.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>;
    if (!contactColumns.some((column) => column.name === 'affiliation_confirmed')) this.raw.exec('ALTER TABLE contacts ADD COLUMN affiliation_confirmed INTEGER NOT NULL DEFAULT 0');
    if (!contactColumns.some((column) => column.name === 'job_revision')) this.raw.exec('ALTER TABLE contacts ADD COLUMN job_revision INTEGER NOT NULL DEFAULT 1');
    if (!contactColumns.some((column) => column.name === 'revision')) this.raw.exec('ALTER TABLE contacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (needsTrustMigration) {
      this.raw.prepare('UPDATE contacts SET affiliation_confirmed=0').run();
      this.raw.prepare('UPDATE approvals SET invalidated_at=? WHERE invalidated_at IS NULL').run(now());
    }
    const taskColumns = this.raw.prepare('PRAGMA table_info(workflow_tasks)').all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === 'generation')) this.raw.exec('ALTER TABLE workflow_tasks ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    const sendColumns = this.raw.prepare('PRAGMA table_info(sends)').all() as Array<{ name: string }>;
    if (!sendColumns.some((column) => column.name === 'replaceable')) this.raw.exec('ALTER TABLE sends ADD COLUMN replaceable INTEGER NOT NULL DEFAULT 0');
    const historyColumns = this.raw.prepare('PRAGMA table_info(send_history)').all() as Array<{ name: string }>;
    if (!historyColumns.some((column) => column.name === 'replaceable')) this.raw.exec('ALTER TABLE send_history ADD COLUMN replaceable INTEGER NOT NULL DEFAULT 0');
    this.raw.prepare('INSERT OR IGNORE INTO job_runs(job_id,run_id,title,company,location,description,status,score,rationale,source_url,retrieved_at) SELECT id,run_id,title,company,location,description,status,score,rationale,source_url,retrieved_at FROM jobs').run();
    this.raw.prepare("UPDATE sends SET status='uncertain',error=COALESCE(error,'Daemon restarted during Gmail dispatch; reconcile manually'),updated_at=? WHERE status='dispatching'").run(now());
    if (needsTrustMigration) this.raw.prepare('INSERT INTO migration_versions(version,applied_at) VALUES (?,?)').run('trust-revisions-v1', now());
    }).immediate();
  }

  close() { this.raw.close(); }

  getSettings(): Settings {
    const row = this.raw.prepare('SELECT * FROM settings WHERE id=1').get() as any;
    return { approvalMode: row.approval_mode, jobsPerRun: row.jobs_per_run, enrichmentsPerRun: row.enrichments_per_run, dailySendLimit: row.daily_send_limit, paused: Boolean(row.paused) };
  }

  updateSettings(input: Partial<Settings>): Settings {
    const value = { ...this.getSettings(), ...input };
    this.raw.prepare('UPDATE settings SET approval_mode=?,jobs_per_run=?,enrichments_per_run=?,daily_send_limit=?,paused=? WHERE id=1')
      .run(value.approvalMode, value.jobsPerRun, value.enrichmentsPerRun, value.dailySendLimit, Number(value.paused));
    this.event('settings.updated', value);
    return value;
  }

  getProfile(): Profile | null {
    const row = this.raw.prepare('SELECT * FROM profiles WHERE id=?').get('default') as any;
    return row ? { id: row.id, name: row.name, email: row.email, summary: row.summary, skills: parse(row.skills), targetRoles: parse(row.target_roles), locations: parse(row.locations), remote: Boolean(row.remote), confirmed: Boolean(row.confirmed) } : null;
  }

  saveProfile(profile: Profile): Profile {
    this.raw.prepare(`INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,email=excluded.email,summary=excluded.summary,skills=excluded.skills,target_roles=excluded.target_roles,
      locations=excluded.locations,remote=excluded.remote,confirmed=excluded.confirmed`)
      .run(profile.id, profile.name, profile.email, profile.summary, JSON.stringify(profile.skills), JSON.stringify(profile.targetRoles), JSON.stringify(profile.locations), Number(profile.remote), Number(profile.confirmed));
    this.event('profile.updated', { id: profile.id });
    return profile;
  }

  createRun(query: string): Run {
    const value: Run = { id: id(), query, status: 'queued', stage: 'search', createdAt: now(), updatedAt: now(), error: null };
    this.raw.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?)').run(value.id, value.query, value.status, value.stage, value.createdAt, value.updatedAt, null);
    this.enqueue(`run:${value.id}:search`, 'search', { runId: value.id });
    this.event('run.created', value);
    return value;
  }

  updateRun(runId: string, input: Partial<Pick<Run, 'status' | 'stage' | 'error'>>): Run {
    const current = this.getRun(runId);
    if (!current) throw new Error('Run not found');
    const value = { ...current, ...input, updatedAt: now() };
    this.raw.prepare('UPDATE runs SET status=?,stage=?,updated_at=?,error=? WHERE id=?').run(value.status, value.stage, value.updatedAt, value.error, runId);
    this.event('run.updated', value);
    return value;
  }

  getRun(runId: string): Run | null {
    const row = this.raw.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
    return row ? this.mapRun(row) : null;
  }
  listRuns(): Run[] { return (this.raw.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as any[]).map((row) => this.mapRun(row)); }
  private mapRun(row: any): Run { return { id: row.id, query: row.query, status: row.status, stage: row.stage, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error }; }

  upsertJob(runId: string, input: Omit<Job, 'id' | 'runId'>): Job {
    return this.raw.transaction(() => {
      const run = this.raw.prepare('SELECT rowid AS ordinal FROM runs WHERE id=?').get(runId) as { ordinal: number } | undefined;
      if (!run) throw new Error('Run not found');
      const existing = this.raw.prepare('SELECT * FROM jobs WHERE canonical_url=?').get(input.canonicalUrl) as any | undefined;
      const jobId = existing?.id ?? id();
      if (existing) {
        const currentRun = this.raw.prepare('SELECT rowid AS ordinal FROM runs WHERE id=?').get(existing.run_id) as { ordinal: number } | undefined;
        if (!currentRun || run.ordinal >= currentRun.ordinal) {
          const claimsChanged = ['title', 'company', 'location', 'description', 'status'].some((key) => existing[key] !== input[key as keyof typeof input]);
          this.raw.prepare('UPDATE jobs SET run_id=?,title=?,company=?,location=?,description=?,status=?,score=?,rationale=?,source_url=?,retrieved_at=?,revision=revision+? WHERE id=?')
            .run(runId, input.title, input.company, input.location, input.description, input.status, input.score, input.rationale, input.sourceUrl, input.retrievedAt, Number(claimsChanged), jobId);
          if (claimsChanged) {
            this.raw.prepare('UPDATE contacts SET affiliation_confirmed=0 WHERE job_id=?').run(jobId);
            this.raw.prepare('UPDATE approvals SET invalidated_at=? WHERE invalidated_at IS NULL AND draft_id IN (SELECT id FROM drafts WHERE job_id=?)').run(now(), jobId);
            this.event('job.claims-changed', { id: jobId, runId });
          }
        }
      } else {
        this.raw.prepare('INSERT INTO jobs(id,run_id,canonical_url,title,company,location,description,status,score,rationale,source_url,retrieved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(jobId, runId, input.canonicalUrl, input.title, input.company, input.location, input.description, input.status, input.score, input.rationale, input.sourceUrl, input.retrievedAt);
      }
      this.raw.prepare('INSERT OR IGNORE INTO job_runs(job_id,run_id,title,company,location,description,status,score,rationale,source_url,retrieved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(jobId, runId, input.title, input.company, input.location, input.description, input.status, input.score, input.rationale, input.sourceUrl, input.retrievedAt);
      this.raw.prepare('INSERT INTO job_sources(job_id,url,retrieved_at) VALUES (?,?,?) ON CONFLICT(job_id,url) DO UPDATE SET retrieved_at=excluded.retrieved_at')
        .run(jobId, input.sourceUrl, input.retrievedAt);
      this.event(existing ? 'job.rediscovered' : 'job.created', { id: jobId, runId });
      const job = this.getJob(jobId); if (!job) throw new Error('Job not found');
      return job;
    }).immediate();
  }
  getJob(jobId: string): Job | null { const row = this.raw.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as any; return row ? this.mapJob(row) : null; }
  getJobSnapshot(jobId: string): { job: Job; revision: number; contactSetRevision: number } | null {
    const row = this.raw.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as any;
    return row ? { job: this.mapJob(row), revision: row.revision, contactSetRevision: row.contact_set_revision } : null;
  }
  getDraftContext(jobId: string, contactId: string): { job: Job; contact: Contact; jobRevision: number; contactRevision: number } | null {
    return this.raw.transaction(() => {
      const job = this.getJobSnapshot(jobId);
      const row = this.raw.prepare('SELECT * FROM contacts WHERE id=? AND job_id=?').get(contactId, jobId) as any;
      return job && row ? { job: job.job, contact: this.mapContact(row), jobRevision: job.revision, contactRevision: row.revision } : null;
    })();
  }
  listJobs(runId?: string): Job[] {
    if (!runId) return (this.raw.prepare('SELECT * FROM jobs ORDER BY retrieved_at DESC').all() as any[]).map((row) => this.mapJob(row));
    return (this.raw.prepare(`SELECT jobs.id,jobs.canonical_url,job_runs.run_id,job_runs.title,job_runs.company,
      job_runs.location,job_runs.description,job_runs.status,job_runs.score,job_runs.rationale,
      job_runs.source_url,job_runs.retrieved_at
      FROM jobs JOIN job_runs ON job_runs.job_id=jobs.id WHERE job_runs.run_id=? ORDER BY job_runs.score DESC`).all(runId) as any[])
      .map((row) => this.mapJob(row));
  }
  private mapJob(row: any): Job { return { id: row.id, runId: row.run_id, canonicalUrl: row.canonical_url, title: row.title, company: row.company, location: row.location, description: row.description, status: row.status, score: row.score, rationale: row.rationale, sourceUrl: row.source_url, retrievedAt: row.retrieved_at }; }

  saveContact(jobId: string, contact: Omit<Contact, 'id' | 'jobId' | 'affiliationConfirmed'>): Contact {
    return this.raw.transaction(() => {
    const job = this.raw.prepare('SELECT revision FROM jobs WHERE id=?').get(jobId) as { revision: number } | undefined;
    if (!job) throw new Error('Job not found');
    const normalized = contact.email.trim().toLowerCase();
    const existing = this.raw.prepare('SELECT * FROM contacts WHERE job_id=? AND normalized_email=?').get(jobId, normalized) as any;
    if (existing) {
      const changed = existing.job_revision !== job.revision || existing.name !== contact.name || existing.role !== contact.role || Boolean(existing.verified) !== contact.verified || existing.affiliation_evidence !== contact.affiliationEvidence || existing.email_evidence !== contact.emailEvidence;
      if (changed) {
        this.raw.prepare('UPDATE contacts SET name=?,email=?,role=?,verified=?,affiliation_evidence=?,affiliation_confirmed=0,email_evidence=?,job_revision=?,revision=revision+1 WHERE id=?')
          .run(contact.name, contact.email, contact.role, Number(contact.verified), contact.affiliationEvidence, contact.emailEvidence, job.revision, existing.id);
        this.raw.prepare('UPDATE approvals SET invalidated_at=? WHERE invalidated_at IS NULL AND draft_id IN (SELECT id FROM drafts WHERE contact_id=?)').run(now(), existing.id);
        this.raw.prepare('UPDATE jobs SET contact_set_revision=contact_set_revision+1 WHERE id=?').run(jobId);
        this.event('contact.updated', { id: existing.id, jobId });
      }
      const updated = this.getContact(existing.id); if (!updated) throw new Error('Contact not found');
      return updated;
    }
    const value: Contact = { id: id(), jobId, ...contact, affiliationConfirmed: false };
    this.raw.prepare('INSERT INTO contacts(id,job_id,name,email,normalized_email,role,verified,affiliation_evidence,affiliation_confirmed,email_evidence,job_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(value.id, jobId, value.name, value.email, normalized, value.role, Number(value.verified), value.affiliationEvidence, 0, value.emailEvidence, job.revision);
    this.raw.prepare('UPDATE jobs SET contact_set_revision=contact_set_revision+1 WHERE id=?').run(jobId);
    this.event('contact.created', { id: value.id, jobId });
    return value;
    }).immediate();
  }
  getContact(contactId: string): Contact | null { const row = this.raw.prepare('SELECT * FROM contacts WHERE id=?').get(contactId) as any; return row ? this.mapContact(row) : null; }
  listContacts(jobId?: string): Contact[] { const rows = (jobId ? this.raw.prepare('SELECT * FROM contacts WHERE job_id=?').all(jobId) : this.raw.prepare('SELECT * FROM contacts').all()) as any[]; return rows.map((row) => this.mapContact(row)); }
  enqueueContactResearch(jobId: string): string {
    return this.raw.transaction(() => {
      const job = this.getJob(jobId); if (!job) throw new Error('Job not found');
      const key = `job:${jobId}:contact`;
      const existing = this.raw.prepare('SELECT id,status FROM workflow_tasks WHERE logical_key=?').get(key) as { id: string; status: string } | undefined;
      if (existing && !['completed', 'failed'].includes(existing.status)) return existing.id;
      if (this.contactAttemptsForRun(job.runId) >= this.getSettings().enrichmentsPerRun) throw new Error('Contact enrichment limit reached for this run');
      return this.enqueue(key, 'contact', { jobId }, undefined, true);
    }).immediate();
  }
  contactAttemptsForRun(runId: string): number {
    return (this.raw.prepare('SELECT COUNT(*) AS total FROM contact_attempts WHERE run_id=?').get(runId) as { total: number }).total;
  }
  reserveContactAttempt(jobId: string, taskId: string, owner: string, generation: number, attempt: number,
    expected?: { runId: string; revision: number; contactSetRevision: number }): void {
    this.raw.transaction(() => {
      const snapshot = this.getJobSnapshot(jobId); if (!snapshot) throw new Error('Job not found');
      const job = snapshot.job;
      if (expected && (job.runId !== expected.runId || snapshot.revision !== expected.revision || snapshot.contactSetRevision !== expected.contactSetRevision)) throw new Error('Job or contact details changed before research');
      const task = this.raw.prepare("SELECT 1 FROM workflow_tasks WHERE id=? AND type='contact' AND logical_key=? AND status='running' AND lease_owner=? AND generation=? AND attempts=? AND lease_until>?")
        .get(taskId, `job:${jobId}:contact`, owner, generation, attempt, now());
      if (!task) throw new Error('Contact task lease is not active');
      const prior = this.raw.prepare('SELECT 1 FROM contact_attempts WHERE task_id=? AND generation=? AND attempt=?').get(taskId, generation, attempt);
      if (prior) throw new Error('Contact provider attempt already reserved');
      if (this.contactAttemptsForRun(job.runId) >= this.getSettings().enrichmentsPerRun) throw new Error('Contact enrichment limit reached for this run');
      const timestamp = now();
      this.raw.prepare('INSERT INTO contact_attempts(task_id,generation,attempt,run_id,created_at) VALUES (?,?,?,?,?)').run(taskId, generation, attempt, job.runId, timestamp);
      this.raw.prepare('INSERT INTO provider_usage(run_id,provider,operation,units,created_at) VALUES (?,?,?,?,?)').run(job.runId, 'contacts', 'find', 1, timestamp);
      this.event('contact.attempt-reserved', { jobId, taskId, generation, attempt });
    }).immediate();
  }
  saveContactsIfCurrent(jobId: string, expected: { runId: string; revision: number; contactSetRevision: number },
    task: { id: string; owner: string; generation: number; attempt: number },
    contacts: Array<Omit<Contact, 'id' | 'jobId' | 'affiliationConfirmed'>>): Contact[] {
    return this.raw.transaction(() => {
      const snapshot = this.getJobSnapshot(jobId);
      if (!snapshot || snapshot.job.runId !== expected.runId || snapshot.revision !== expected.revision || snapshot.contactSetRevision !== expected.contactSetRevision) throw new Error('Job or contact details changed during research');
      const lease = this.raw.prepare("SELECT 1 FROM workflow_tasks WHERE id=? AND status='running' AND lease_owner=? AND generation=? AND attempts=? AND lease_until>?")
        .get(task.id, task.owner, task.generation, task.attempt, now());
      if (!lease) throw new Error('Contact task lease expired during research');
      return contacts.map((contact) => this.saveContact(jobId, contact));
    }).immediate();
  }
  private mapContact(row: any): Contact { return { id: row.id, jobId: row.job_id, name: row.name, email: row.email, role: row.role, verified: Boolean(row.verified), affiliationEvidence: row.affiliation_evidence, affiliationConfirmed: Boolean(row.affiliation_confirmed), emailEvidence: row.email_evidence }; }
  confirmContactAffiliation(contactId: string): Contact {
    return this.raw.transaction(() => {
    const contact = this.getContact(contactId); if (!contact) throw new Error('Contact not found');
    const versions = this.raw.prepare('SELECT contacts.job_revision,jobs.revision AS current_revision FROM contacts JOIN jobs ON jobs.id=contacts.job_id WHERE contacts.id=?').get(contactId) as { job_revision: number; current_revision: number } | undefined;
    if (!versions || versions.job_revision !== versions.current_revision) throw new Error('Job details changed; research this contact again before confirmation');
    if (!contact.affiliationEvidence) throw new Error('Affiliation evidence is required');
    this.raw.prepare('UPDATE contacts SET affiliation_confirmed=1 WHERE id=?').run(contactId);
    this.raw.prepare('UPDATE jobs SET contact_set_revision=contact_set_revision+1 WHERE id=?').run(contact.jobId);
    this.event('contact.affiliation-confirmed', { id: contactId }); return this.getContact(contactId)!;
    }).immediate();
  }

  createDraft(jobId: string, contactId: string, subject: string, body: string, safeForAutomatic = false,
    expected?: { jobRevision: number; contactRevision: number }): Draft {
    return this.raw.transaction(() => {
      const job = this.raw.prepare('SELECT revision FROM jobs WHERE id=?').get(jobId) as { revision: number } | undefined;
      if (!job) throw new Error('Job not found');
      const contact = this.raw.prepare('SELECT revision FROM contacts WHERE id=? AND job_id=?').get(contactId, jobId) as { revision: number } | undefined;
      if (!contact) throw new Error('Contact not found for job');
      if (expected && (job.revision !== expected.jobRevision || contact.revision !== expected.contactRevision)) throw new Error('Job or contact details changed during drafting');
      const latest = this.raw.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM drafts WHERE job_id=? AND contact_id=?').get(jobId, contactId) as { revision: number };
      const value: Draft = { id: id(), jobId, contactId, revision: latest.revision + 1, subject, body, safeForAutomatic, createdAt: now() };
      this.raw.prepare('INSERT INTO drafts(id,job_id,contact_id,revision,subject,body,safe_automatic,created_at,job_revision,contact_revision) VALUES (?,?,?,?,?,?,?,?,?,?)').run(value.id, jobId, contactId, value.revision, subject, body, Number(safeForAutomatic), value.createdAt, job.revision, contact.revision);
      this.raw.prepare('UPDATE approvals SET invalidated_at=? WHERE draft_id IN (SELECT id FROM drafts WHERE job_id=? AND contact_id=? AND id<>?) AND invalidated_at IS NULL').run(value.createdAt, jobId, contactId, value.id);
      this.event('draft.created', { id: value.id, jobId, contactId, revision: value.revision });
      return value;
    })();
  }
  getDraft(draftId: string): Draft | null { const row = this.raw.prepare('SELECT * FROM drafts WHERE id=?').get(draftId) as any; return row ? this.mapDraft(row) : null; }
  listDrafts(): Draft[] { return (this.raw.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all() as any[]).map((row) => this.mapDraft(row)); }
  private mapDraft(row: any): Draft { return { id: row.id, jobId: row.job_id, contactId: row.contact_id, revision: row.revision, subject: row.subject, body: row.body, safeForAutomatic: Boolean(row.safe_automatic), createdAt: row.created_at }; }

  approve(draftId: string, mode: string) {
    const draft = this.getDraft(draftId); if (!draft) throw new Error('Draft not found');
    this.assertDraftCurrent(draft);
    const contact = this.getContact(draft.contactId); if (!contact) throw new Error('Contact not found');
    const value = { id: id(), draftId, recipient: contact.email.toLowerCase(), mode, approvedAt: now() };
    this.raw.prepare('INSERT INTO approvals(id,draft_id,recipient,mode,approved_at) VALUES (?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET recipient=excluded.recipient,mode=excluded.mode,approved_at=excluded.approved_at,invalidated_at=NULL').run(value.id, value.draftId, value.recipient, value.mode, value.approvedAt);
    this.event('draft.approved', value);
    return value;
  }

  approveBatch(draftIds: string[]) {
    if (this.getSettings().approvalMode !== 'batch') throw new Error('Batch approval requires batch mode');
    return this.raw.transaction(() => draftIds.map((draftId) => this.approve(draftId, 'batch')))();
  }

  private assertSendPolicy(draft: Draft, contact: Contact, excludeSendId = '') {
    const settings = this.getSettings();
    if (settings.paused) throw new Error('Outreach is paused');
    this.assertDraftCurrent(draft);
    const approval = this.raw.prepare('SELECT 1 FROM approvals WHERE draft_id=? AND invalidated_at IS NULL AND recipient=?').get(draft.id, contact.email.toLowerCase());
    const automatic = settings.approvalMode === 'automatic' && draft.safeForAutomatic && contact.verified && contact.affiliationConfirmed && Boolean(contact.affiliationEvidence) && Boolean(contact.emailEvidence);
    if (!approval && !automatic) throw new Error('Exact draft and recipient are not approved');
    if (this.raw.prepare('SELECT 1 FROM suppressions WHERE email=?').get(contact.email.toLowerCase())) throw new Error('Recipient is suppressed');
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const sentToday = (this.raw.prepare("SELECT COUNT(*) AS total FROM sends WHERE status IN ('reserved','dispatching','sent','uncertain') AND created_at>=? AND id<>?").get(since.toISOString(), excludeSendId) as { total: number }).total;
    if (sentToday >= settings.dailySendLimit) throw new Error('Daily send limit reached');
  }

  private assertDraftCurrent(draft: Draft) {
    if (!this.isDraftCurrent(draft)) throw new Error('Job or contact details changed; new draft approval is required');
  }

  private isDraftCurrent(draft: Draft): boolean {
    const row = this.raw.prepare(`SELECT drafts.job_revision, jobs.revision AS current_job_revision,
      drafts.contact_revision, contacts.revision AS current_contact_revision, drafts.revision AS draft_revision,
      (SELECT MAX(revision) FROM drafts AS latest WHERE latest.job_id=drafts.job_id AND latest.contact_id=drafts.contact_id) AS latest_revision
      FROM drafts JOIN jobs ON jobs.id=drafts.job_id JOIN contacts ON contacts.id=drafts.contact_id WHERE drafts.id=?`)
      .get(draft.id) as { job_revision: number; current_job_revision: number; contact_revision: number; current_contact_revision: number; draft_revision: number; latest_revision: number } | undefined;
    return Boolean(row && row.job_revision === row.current_job_revision && row.contact_revision === row.current_contact_revision && row.draft_revision === row.latest_revision);
  }

  reserveSend(draftId: string): Send {
    return this.raw.transaction(() => {
      const draft = this.getDraft(draftId); if (!draft) throw new Error('Draft not found');
      const contact = this.getContact(draft.contactId); if (!contact) throw new Error('Contact not found');
      const value: Send = { id: id(), jobId: draft.jobId, contactId: draft.contactId, draftId, status: 'reserved', gmailMessageId: null, error: null, createdAt: now(), updatedAt: now() };
      const prior = this.raw.prepare('SELECT * FROM sends WHERE job_id=? AND contact_id=?').get(value.jobId, value.contactId) as any | undefined;
      if (prior) {
        if (prior.status === 'reserved') {
          const earlierDraft = this.getDraft(prior.draft_id);
          if (earlierDraft && !this.isDraftCurrent(earlierDraft)) {
            this.raw.prepare("UPDATE sends SET status='cancelled',error=?,replaceable=1,updated_at=? WHERE id=? AND status='reserved'").run(staleReservedReason, now(), prior.id);
            this.raw.prepare("UPDATE workflow_tasks SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE logical_key=? AND status IN ('queued','running')").run(now(), `send:${prior.id}`);
            prior.status = 'cancelled'; prior.error = staleReservedReason; prior.replaceable = 1;
            this.event('send.cancelled', this.getSend(prior.id));
          }
        }
        if (!['cancelled', 'failed'].includes(prior.status) || prior.replaceable !== 1) throw new Error('Initial outreach already exists for this job and contact');
        this.assertSendPolicy(draft, contact);
        this.raw.prepare('INSERT INTO send_history(id,job_id,contact_id,draft_id,status,gmail_message_id,error,created_at,updated_at,archived_at,replaceable) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(prior.id, prior.job_id, prior.contact_id, prior.draft_id, prior.status, prior.gmail_message_id, prior.error, prior.created_at, prior.updated_at, now(), prior.replaceable);
        this.raw.prepare("UPDATE sends SET id=?,draft_id=?,status='reserved',gmail_message_id=NULL,error=NULL,replaceable=0,created_at=?,updated_at=? WHERE id=?")
          .run(value.id, value.draftId, value.createdAt, value.updatedAt, prior.id);
        this.event('send.replaced', { previousId: prior.id, newId: value.id });
      } else {
        this.assertSendPolicy(draft, contact);
        this.raw.prepare('INSERT INTO sends(id,job_id,contact_id,draft_id,status,gmail_message_id,error,created_at,updated_at,replaceable) VALUES (?,?,?,?,?,?,?,?,?,0)').run(value.id, value.jobId, value.contactId, value.draftId, value.status, null, null, value.createdAt, value.updatedAt);
      }
      this.event('send.reserved', value);
      return value;
    }).immediate();
  }

  beginDispatch(sendId: string, taskId: string, owner: string): { send: Send; draft: Draft; contact: Contact } | null {
    return this.raw.transaction(() => {
      const send = this.getSend(sendId); if (!send || send.status !== 'reserved') throw new Error('Send is not reserved');
      const task = this.raw.prepare("SELECT 1 FROM workflow_tasks WHERE id=? AND lease_owner=? AND status='running'").get(taskId, owner);
      if (!task) throw new Error('Send task lease is not active');
      const draft = this.getDraft(send.draftId); const contact = this.getContact(send.contactId);
      if (!draft || !contact) throw new Error('Draft or contact missing');
      if (!this.isDraftCurrent(draft)) {
        const timestamp = now();
        this.raw.prepare("UPDATE sends SET status='cancelled',error=?,replaceable=1,updated_at=? WHERE id=? AND status='reserved'").run(staleReservedReason, timestamp, sendId);
        this.raw.prepare("UPDATE workflow_tasks SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(timestamp, taskId, owner);
        this.event('send.cancelled', this.getSend(sendId));
        return null;
      }
      this.assertSendPolicy(draft, contact, sendId);
      const timestamp = now();
      const changed = this.raw.prepare("UPDATE sends SET status='dispatching',error=?,updated_at=? WHERE id=? AND status='reserved'")
        .run('Gmail dispatch started; reconcile manually if the daemon exits before completion', timestamp, sendId);
      if (changed.changes !== 1) throw new Error('Send is already being dispatched');
      this.raw.prepare("UPDATE workflow_tasks SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(timestamp, taskId, owner);
      this.event('send.dispatching', { id: sendId });
      return { send: this.getSend(sendId)!, draft, contact };
    }).immediate();
  }

  updateSend(sendId: string, status: Send['status'], gmailMessageId: string | null, error: string | null, replaceable = false): Send {
    this.raw.prepare('UPDATE sends SET status=?,gmail_message_id=?,error=?,replaceable=?,updated_at=? WHERE id=?').run(status, gmailMessageId, error, replaceable ? 1 : 0, now(), sendId);
    const value = this.getSend(sendId); if (!value) throw new Error('Send not found');
    this.event(`send.${status}`, value); return value;
  }
  getSend(sendId: string): Send | null { const row = this.raw.prepare('SELECT * FROM sends WHERE id=?').get(sendId) as any; return row ? this.mapSend(row) : null; }
  listSends(): Send[] { return (this.raw.prepare(`SELECT id,job_id,contact_id,draft_id,status,gmail_message_id,error,created_at,updated_at FROM sends
    UNION ALL SELECT id,job_id,contact_id,draft_id,status,gmail_message_id,error,created_at,updated_at FROM send_history
    ORDER BY created_at DESC`).all() as any[]).map((row) => this.mapSend(row)); }
  private mapSend(row: any): Send { return { id: row.id, jobId: row.job_id, contactId: row.contact_id, draftId: row.draft_id, status: row.status, gmailMessageId: row.gmail_message_id, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }; }

  enqueue(logicalKey: string, type: string, payload: unknown, availableAt = now(), requeueTerminal = false): string {
    return this.raw.transaction(() => {
      const existing = this.raw.prepare('SELECT id,status FROM workflow_tasks WHERE logical_key=?').get(logicalKey) as { id: string; status: string } | undefined;
      if (existing) {
        if (requeueTerminal && ['completed', 'failed'].includes(existing.status)) {
          this.raw.prepare("UPDATE workflow_tasks SET type=?,payload=?,status='queued',attempts=0,generation=generation+1,available_at=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?")
            .run(type, JSON.stringify(payload), availableAt, now(), existing.id);
        }
        return existing.id;
      }
      const taskId = id(); const createdAt = now();
      this.raw.prepare(`INSERT INTO workflow_tasks(id,logical_key,type,payload,status,available_at,created_at,updated_at)
        VALUES (?,?,?,?, 'queued',?,?,?)`).run(taskId, logicalKey, type, JSON.stringify(payload), availableAt, createdAt, createdAt);
      return taskId;
    })();
  }

  claim(owner: string, leaseMs = 30_000): Task | null {
    return this.raw.transaction(() => {
      const timestamp = now();
      const row = this.raw.prepare(`SELECT * FROM workflow_tasks WHERE attempts < max_attempts AND available_at<=?
        AND (status='queued' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1`).get(timestamp, timestamp) as any;
      if (!row) return null;
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      this.raw.prepare("UPDATE workflow_tasks SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?").run(owner, leaseUntil, timestamp, row.id);
      return { id: row.id, logicalKey: row.logical_key, type: row.type, payload: parse(row.payload), attempts: row.attempts + 1, generation: row.generation, maxAttempts: row.max_attempts, leaseOwner: owner, leaseUntil };
    })();
  }

  completeTask(taskId: string, owner: string) { this.raw.prepare("UPDATE workflow_tasks SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(now(), taskId, owner); }
  failTask(taskId: string, owner: string, error: string, delayMs = 1_000) {
    const task = this.raw.prepare('SELECT attempts,max_attempts FROM workflow_tasks WHERE id=? AND lease_owner=?').get(taskId, owner) as { attempts: number; max_attempts: number } | undefined;
    if (!task) return;
    const status = task.attempts >= task.max_attempts ? 'failed' : 'queued';
    this.raw.prepare('UPDATE workflow_tasks SET status=?,available_at=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=?').run(status, new Date(Date.now() + delayMs).toISOString(), error, now(), taskId);
  }

  getSchedule(): Schedule { const row = this.raw.prepare('SELECT * FROM schedules WHERE id=1').get() as any; return { enabled: Boolean(row.enabled), cron: row.cron, timezone: row.timezone, lastRunAt: row.last_run_at }; }
  updateSchedule(input: Schedule): Schedule { this.raw.prepare('UPDATE schedules SET enabled=?,cron=?,timezone=?,last_run_at=? WHERE id=1').run(Number(input.enabled), input.cron, input.timezone, input.lastRunAt); return input; }
  createScheduledRun(query: string, observedAt: string): Run | null {
    return this.raw.transaction(() => {
      const profile = this.getProfile();
      if (!profile?.confirmed || profile.targetRoles.length === 0 || this.getSettings().paused) return null;
      const schedule = this.getSchedule();
      if (!schedule.enabled || schedule.lastRunAt && schedule.lastRunAt >= observedAt) return null;
      const run = this.createRun(query);
      this.raw.prepare('UPDATE schedules SET last_run_at=? WHERE id=1').run(observedAt);
      return run;
    })();
  }
  suppress(email: string, reason: string) { this.raw.prepare('INSERT OR REPLACE INTO suppressions VALUES (?,?,?)').run(email.trim().toLowerCase(), reason, now()); }
  recordUsage(runId: string | null, provider: string, operation: string, units: number) { this.raw.prepare('INSERT INTO provider_usage(run_id,provider,operation,units,created_at) VALUES (?,?,?,?,?)').run(runId, provider, operation, units, now()); }
  listEvents(after = 0) { return (this.raw.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(after) as any[]).map((row) => ({ id: row.id, type: row.type, data: parse(row.data), createdAt: row.created_at })); }
  private event(type: string, data: unknown) { this.raw.prepare('INSERT INTO events(type,data,created_at) VALUES (?,?,?)').run(type, JSON.stringify(data), now()); }
}
