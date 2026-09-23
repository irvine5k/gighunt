import { Static, Type } from '@sinclair/typebox';

export const Id = Type.String({ minLength: 1 });
export const ApprovalMode = Type.Union([
  Type.Literal('individual'),
  Type.Literal('batch'),
  Type.Literal('automatic'),
]);
export type ApprovalMode = Static<typeof ApprovalMode>;

export const Profile = Type.Object({
  id: Id,
  name: Type.String(),
  email: Type.String({ minLength: 3 }),
  summary: Type.String(),
  skills: Type.Array(Type.String()),
  targetRoles: Type.Array(Type.String()),
  locations: Type.Array(Type.String()),
  remote: Type.Boolean(),
  confirmed: Type.Boolean(),
});
export type Profile = Static<typeof Profile>;
export const ProfileInput = Type.Omit(Profile, ['id'], { additionalProperties: false });

export const Settings = Type.Object({
  approvalMode: ApprovalMode,
  jobsPerRun: Type.Integer({ minimum: 1, maximum: 100 }),
  enrichmentsPerRun: Type.Integer({ minimum: 0, maximum: 50 }),
  dailySendLimit: Type.Integer({ minimum: 0, maximum: 100 }),
  paused: Type.Boolean(),
});
export type Settings = Static<typeof Settings>;
export const SettingsInput = Type.Partial(Settings, { additionalProperties: false });

export const ProviderCredentialName = Type.Union([
  Type.Literal('OPENAI_API_KEY'), Type.Literal('BRAVE_API_KEY'), Type.Literal('HUNTER_API_KEY'),
  Type.Literal('GMAIL_CLIENT_ID'), Type.Literal('GMAIL_CLIENT_SECRET'), Type.Literal('GMAIL_REFRESH_TOKEN'),
]);
export type ProviderCredentialName = Static<typeof ProviderCredentialName>;
export const ProviderCredentialParams = Type.Object({ name: ProviderCredentialName }, { additionalProperties: false });
export const ProviderCredentialInput = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 10000, pattern: '^[^\\r\\n]+$' }),
}, { additionalProperties: false });
export const ProviderCredentialStatus = Type.Object({
  name: ProviderCredentialName,
  configured: Type.Boolean(),
  managedExternally: Type.Boolean(),
});
export type ProviderCredentialStatus = Static<typeof ProviderCredentialStatus>;

export const Run = Type.Object({
  id: Id,
  query: Type.String(),
  status: Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed')]),
  stage: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type Run = Static<typeof Run>;

export const Job = Type.Object({
  id: Id,
  runId: Id,
  canonicalUrl: Type.String(),
  title: Type.String(),
  company: Type.String(),
  location: Type.String(),
  description: Type.String(),
  status: Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('inaccessible')]),
  score: Type.Number(),
  rationale: Type.String(),
  sourceUrl: Type.String(),
  retrievedAt: Type.String(),
});
export type Job = Static<typeof Job>;

export const Contact = Type.Object({
  id: Id,
  jobId: Id,
  name: Type.String(),
  email: Type.String(),
  role: Type.String(),
  verified: Type.Boolean(),
  affiliationEvidence: Type.Union([Type.String(), Type.Null()]),
  affiliationConfirmed: Type.Boolean(),
  emailEvidence: Type.Union([Type.String(), Type.Null()]),
});
export type Contact = Static<typeof Contact>;

export const Draft = Type.Object({
  id: Id,
  jobId: Id,
  contactId: Id,
  revision: Type.Integer({ minimum: 1 }),
  subject: Type.String(),
  body: Type.String(),
  safeForAutomatic: Type.Boolean(),
  createdAt: Type.String(),
});
export type Draft = Static<typeof Draft>;

export const Send = Type.Object({
  id: Id,
  jobId: Id,
  contactId: Id,
  draftId: Id,
  status: Type.Union([
    Type.Literal('reserved'), Type.Literal('dispatching'), Type.Literal('sent'), Type.Literal('failed'), Type.Literal('uncertain'), Type.Literal('cancelled'),
  ]),
  gmailMessageId: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Send = Static<typeof Send>;

export const Schedule = Type.Object({
  enabled: Type.Boolean(),
  cron: Type.String(),
  timezone: Type.String(),
  lastRunAt: Type.Union([Type.String(), Type.Null()]),
});
export type Schedule = Static<typeof Schedule>;

export const IdParams = Type.Object({ id: Id }, { additionalProperties: false });
export const EmptyInput = Type.Object({}, { additionalProperties: false });
export const RunInput = Type.Object({ query: Type.String({ minLength: 2, maxLength: 500 }) }, { additionalProperties: false });
export const JobsQuery = Type.Object({ runId: Type.Optional(Id) }, { additionalProperties: false });
export const ContactsQuery = Type.Object({ jobId: Type.Optional(Id) }, { additionalProperties: false });
export const EventsQuery = Type.Object({ after: Type.Optional(Type.String({ pattern: '^\\d+$' })) }, { additionalProperties: false });
export const DraftCreateInput = Type.Object({ jobId: Id, contactId: Id }, { additionalProperties: false });
export const DraftUpdateInput = Type.Object({
  subject: Type.String({ minLength: 1, maxLength: 998, pattern: '^[^\\r\\n]+$' }),
  body: Type.String({ minLength: 1, maxLength: 100000 }),
}, { additionalProperties: false });
export const AffiliationConfirmationInput = Type.Object({ confirmed: Type.Literal(true) }, { additionalProperties: false });
export const ApprovalInput = Type.Object({ draftId: Id }, { additionalProperties: false });
export const BatchApprovalInput = Type.Object({ draftIds: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }) }, { additionalProperties: false });
export const ReconcileInput = Type.Object({
  outcome: Type.Union([Type.Literal('sent'), Type.Literal('cancelled')]),
  gmailMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$' })),
}, { additionalProperties: false });
export const BootstrapInput = Type.Object({ nonce: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const ScheduleInput = Type.Object({
  enabled: Type.Boolean(), cron: Type.String({ minLength: 1, maxLength: 200 }), timezone: Type.String({ minLength: 1, maxLength: 100 }),
  lastRunAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false });

export const ApiError = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Boolean() }),
});
export type ApiError = Static<typeof ApiError>;

export const Page = <T extends ReturnType<typeof Type.Any>>(item: T) => Type.Object({
  items: Type.Array(item),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const ProviderStatus = Type.Object({
  name: Type.String(),
  configured: Type.Boolean(),
  healthy: Type.Boolean(),
  message: Type.Union([Type.String(), Type.Null()]),
});

export const ServerEvent = Type.Object({
  id: Type.Integer(),
  type: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
});
export type ServerEvent = Static<typeof ServerEvent>;

function assertLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('GigHunt daemon URL must use HTTP on loopback');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('GigHunt daemon URL must be an origin');
  return url.origin;
}

export class GigHuntClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string) {
    this.baseUrl = assertLoopbackBaseUrl(baseUrl);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as any;
      throw new Error(payload?.error?.message ?? `GigHunt request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  get<T>(path: string) { return this.request<T>(path); }
  post<T>(path: string, body: unknown = {}) { return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
}
