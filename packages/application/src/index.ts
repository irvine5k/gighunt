import type { ContactProvider, MailProvider, ModelProvider, PageFetcher, SearchProvider } from '@gighunt/domain';
import { canonicalizeUrl, ProviderError, scoreJob } from '@gighunt/domain';
import type { Draft, Job } from '@gighunt/contracts';
import { GigDatabase, type Task } from '@gighunt/db';

export interface Providers {
  search: SearchProvider;
  pages: PageFetcher;
  model: ModelProvider;
  contacts: ContactProvider;
  mail: MailProvider;
}

export class GigHuntService {
  constructor(public readonly db: GigDatabase, private readonly providers: Providers) {}

  startRun(query: string) {
    const profile = this.db.getProfile();
    if (!profile?.confirmed) throw new Error('Confirm a profile before starting research');
    if (this.db.getSettings().paused) throw new Error('GigHunt is paused');
    return this.db.createRun(query.trim());
  }

  async processTask(task: Task, owner: string): Promise<void> {
    switch (task.type) {
      case 'search': await this.processSearch(task.payload as { runId: string }); return;
      case 'contact': await this.researchContact((task.payload as { jobId: string }).jobId, task, owner); return;
      case 'draft': await this.createDraft((task.payload as { jobId: string; contactId: string }).jobId, (task.payload as { contactId: string }).contactId); return;
      case 'send': await this.dispatchSend((task.payload as { sendId: string }).sendId, task.id, owner); return;
      default: throw new Error(`Unsupported task type: ${task.type}`);
    }
  }

  private async processSearch({ runId }: { runId: string }) {
    const run = this.db.getRun(runId); const profile = this.db.getProfile();
    if (!run || !profile) throw new Error('Run or profile missing');
    this.db.updateRun(runId, { status: 'running', stage: 'search' });
    const results = await this.providers.search.search(run.query, this.db.getSettings().jobsPerRun);
    this.db.recordUsage(runId, 'search', 'query', 1);
    let enrichments = 0;
    for (const result of results) {
      try {
        this.db.updateRun(runId, { stage: 'fetch' });
        const content = await this.providers.pages.fetch(result.url);
        this.db.updateRun(runId, { stage: 'extract' });
        const candidate = await this.providers.model.extractJob(result.url, content);
        const scored = scoreJob(profile, candidate);
        const job = this.db.upsertJob(runId, {
          canonicalUrl: canonicalizeUrl(result.url), title: candidate.title, company: candidate.company,
          location: candidate.location, description: candidate.description, status: 'open', score: scored.score,
          rationale: scored.rationale, sourceUrl: result.url, retrievedAt: new Date().toISOString(),
        });
        if (job.runId === runId && enrichments < this.db.getSettings().enrichmentsPerRun && this.db.contactAttemptsForRun(runId) < this.db.getSettings().enrichmentsPerRun) {
          this.db.enqueueContactResearch(job.id); enrichments++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown listing error';
        this.db.recordUsage(runId, 'workflow', 'listing-error', 1);
        if (error instanceof ProviderError && error.kind === 'authentication') throw error;
        if (message.includes('Invalid URL')) continue;
      }
    }
    this.db.updateRun(runId, { status: 'completed', stage: 'completed' });
  }

  enqueueContactResearch(jobId: string) { return this.db.enqueueContactResearch(jobId); }

  async researchContact(jobId: string, task: Task, owner: string) {
    const snapshot = this.db.getJobSnapshot(jobId); if (!snapshot) throw new Error('Job not found');
    const expected = { runId: snapshot.job.runId, revision: snapshot.revision, contactSetRevision: snapshot.contactSetRevision };
    this.db.reserveContactAttempt(jobId, task.id, owner, task.generation, task.attempts, expected);
    const contacts = await this.providers.contacts.find(snapshot.job.company, snapshot.job.title);
    return this.db.saveContactsIfCurrent(jobId, expected, { id: task.id, owner, generation: task.generation, attempt: task.attempts }, contacts);
  }

  async createDraft(jobId: string, contactId: string): Promise<Draft> {
    const profile = this.db.getProfile(); const context = this.db.getDraftContext(jobId, contactId);
    if (!profile?.confirmed || !context) throw new Error('Confirmed profile, job, and matching contact are required');
    const { job, contact } = context;
    const expected = { jobRevision: context.jobRevision, contactRevision: context.contactRevision };
    if (this.db.getSettings().approvalMode === 'automatic') {
      const clean = (value: string, fallback: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/[^\p{L}\p{N} .,'&+/#()-]/gu, '').trim().slice(0, 120) || fallback;
      const role = clean(job.title, 'the open role'); const company = clean(job.company, 'your company');
      const recipient = clean(contact.name, 'there'); const sender = clean(profile.name, 'Candidate');
      const skills = profile.skills.slice(0, 4).map((skill) => clean(skill, '')).filter(Boolean).join(', ');
      const subject = `Interest in ${role}`;
      const background = skills ? ` My confirmed background includes ${skills}.` : '';
      const body = `Hi ${recipient},\n\nI'm reaching out about the ${role} position at ${company}.${background} I would welcome the chance to discuss the role.\n\nBest,\n${sender}`;
      return this.db.createDraft(job.id, contact.id, subject, body, true, expected);
    }
    const content = await this.providers.model.draft({ profile, job: this.jobCandidateForDraft(job), contact });
    this.db.recordUsage(job.runId, 'model', 'draft', 1);
    return this.db.createDraft(job.id, contact.id, content.subject, content.body, false, expected);
  }

  updateDraft(draftId: string, subject: string, body: string): Draft {
    const prior = this.db.getDraft(draftId); if (!prior) throw new Error('Draft not found');
    return this.db.createDraft(prior.jobId, prior.contactId, subject, body, false);
  }

  approve(draftId: string) { return this.db.approve(draftId, this.db.getSettings().approvalMode); }
  approveBatch(draftIds: string[]) { return this.db.approveBatch(draftIds); }
  confirmContactAffiliation(contactId: string) { return this.db.confirmContactAffiliation(contactId); }

  queueSend(draftId: string) {
    const send = this.db.reserveSend(draftId);
    this.db.enqueue(`send:${send.id}`, 'send', { sendId: send.id });
    return send;
  }

  private async dispatchSend(sendId: string, taskId: string, owner: string) {
    const dispatch = this.db.beginDispatch(sendId, taskId, owner);
    if (!dispatch) return;
    const { send, draft, contact } = dispatch;
    try {
      const result = await this.providers.mail.send({ to: contact.email, subject: draft.subject, body: draft.body, idempotencyKey: send.id });
      this.db.updateSend(send.id, 'sent', result.messageId, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown mail failure';
      const uncertain = !(error instanceof ProviderError) || error.kind === 'retryable';
      const replaceable = error instanceof ProviderError && error.kind !== 'retryable';
      this.db.updateSend(send.id, uncertain ? 'uncertain' : 'failed', null, message, !uncertain && replaceable);
    }
  }

  reconcile(sendId: string, outcome: 'sent' | 'cancelled', gmailMessageId?: string) {
    const send = this.db.getSend(sendId); if (!send || send.status !== 'uncertain') throw new Error('Only uncertain sends may be reconciled');
    return this.db.updateSend(sendId, outcome, gmailMessageId ?? null, outcome === 'cancelled' ? 'Manually confirmed not sent' : null);
  }

  private jobCandidateForDraft(job: Job) {
    return { url: job.canonicalUrl, title: job.title.slice(0, 200), company: job.company.slice(0, 200), location: job.location.slice(0, 200), description: '' };
  }
}

export class QueueWorker {
  private timer: NodeJS.Timeout | undefined;
  private working = false;
  constructor(private readonly db: GigDatabase, private readonly service: GigHuntService, private readonly owner = `worker-${process.pid}`) {}
  start(intervalMs = 500) { if (!this.timer) this.timer = setInterval(() => void this.tick(), intervalMs); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick() {
    if (this.working || this.db.getSettings().paused) return;
    const task = this.db.claim(this.owner); if (!task) return;
    this.working = true;
    try { await this.service.processTask(task, this.owner); this.db.completeTask(task.id, this.owner); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown task error';
      this.db.failTask(task.id, this.owner, message, Math.min(60_000, 1000 * 2 ** task.attempts));
      if (task.type === 'search') this.db.updateRun((task.payload as { runId: string }).runId, { status: task.attempts >= task.maxAttempts ? 'failed' : 'queued', error: message });
    } finally { this.working = false; }
  }
}
