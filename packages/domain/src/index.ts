export type ProviderErrorKind = 'authentication' | 'quota' | 'retryable' | 'invalid-response' | 'blocked-request';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || ['ref', 'source'].includes(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.toString();
}

export interface JobCandidate {
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
}

export interface ContactCandidate {
  name: string;
  email: string;
  role: string;
  verified: boolean;
  affiliationEvidence: string | null;
  emailEvidence: string | null;
}

export interface DraftContent { subject: string; body: string; safeForAutomatic?: boolean }

export interface ModelProvider {
  extractJob(url: string, content: string): Promise<JobCandidate>;
  draft(input: { profile: unknown; job: JobCandidate; contact: ContactCandidate }): Promise<DraftContent>;
}

export interface SearchProvider { search(query: string, limit: number): Promise<Array<{ url: string; title: string; snippet: string }>> }
export interface ContactProvider { find(company: string, jobTitle: string): Promise<ContactCandidate[]> }
export interface MailProvider { send(input: { to: string; subject: string; body: string; idempotencyKey: string }): Promise<{ messageId: string }> }
export interface PageFetcher { fetch(url: string): Promise<string> }

export function scoreJob(profile: { skills: string[]; targetRoles: string[]; locations: string[]; remote: boolean }, job: JobCandidate) {
  const haystack = `${job.title} ${job.description}`.toLowerCase();
  const skills = profile.skills.filter((skill) => haystack.includes(skill.toLowerCase()));
  const role = profile.targetRoles.some((target) => job.title.toLowerCase().includes(target.toLowerCase()));
  const location = profile.remote && /remote/i.test(job.location) || profile.locations.some((item) => job.location.toLowerCase().includes(item.toLowerCase()));
  const score = Math.min(100, skills.length * 15 + (role ? 35 : 0) + (location ? 20 : 0));
  return { score, rationale: `${skills.length} skill matches; role ${role ? 'matches' : 'unknown'}; location ${location ? 'matches' : 'unknown'}` };
}
