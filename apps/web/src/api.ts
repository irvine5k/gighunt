import type { Contact, Draft, Job, Profile, ProviderCredentialName, ProviderCredentialStatus, Run, Schedule, Send, Settings } from '@gighunt/contracts';

let csrf = sessionStorage.getItem('gighunt.csrf');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); headers.set('Content-Type', 'application/json'); if (csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) { const payload = await response.json().catch(() => null) as any; throw new Error(payload?.error?.message ?? `Request failed (${response.status})`); }
  return response.json() as Promise<T>;
}

export async function bootstrap() {
  const params = new URLSearchParams(location.search); const nonce = params.get('bootstrap'); if (!nonce) return;
  const result = await request<{ csrfToken: string }>('/auth/bootstrap', { method: 'POST', body: JSON.stringify({ nonce }) });
  csrf = result.csrfToken; sessionStorage.setItem('gighunt.csrf', csrf); history.replaceState({}, '', '/');
}

export const api = {
  profile: () => request<Profile | null>('/profile'),
  saveProfile: (value: Omit<Profile, 'id'>) => request<Profile>('/profile', { method: 'PUT', body: JSON.stringify(value) }),
  settings: () => request<Settings>('/settings'),
  updateSettings: (value: Partial<Settings>) => request<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(value) }),
  providerCredentials: () => request<ProviderCredentialStatus[]>('/provider-credentials'),
  saveProviderCredential: (name: ProviderCredentialName, value: string) => request<ProviderCredentialStatus>(`/provider-credentials/${name}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  runs: () => request<Run[]>('/runs'), startRun: (query: string) => request<Run>('/runs', { method: 'POST', body: JSON.stringify({ query }) }),
  jobs: () => request<Job[]>('/jobs'), contacts: () => request<Contact[]>('/contacts'), drafts: () => request<Draft[]>('/drafts'), sends: () => request<Send[]>('/outreach'),
  researchContact: (jobId: string) => request(`/jobs/${jobId}/research-contact`, { method: 'POST', body: '{}' }),
  confirmAffiliation: (contactId: string) => request<Contact>(`/contacts/${contactId}/confirm-affiliation`, { method: 'PUT', body: JSON.stringify({ confirmed: true }) }),
  draft: (jobId: string, contactId: string) => request<Draft>('/drafts', { method: 'POST', body: JSON.stringify({ jobId, contactId }) }),
  updateDraft: (id: string, subject: string, body: string) => request<Draft>(`/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ subject, body }) }),
  approve: (draftId: string) => request('/outreach/approve', { method: 'POST', body: JSON.stringify({ draftId }) }),
  approveBatch: (draftIds: string[]) => request('/outreach/approve-batch', { method: 'POST', body: JSON.stringify({ draftIds }) }),
  send: (draftId: string) => request('/outreach/send', { method: 'POST', body: JSON.stringify({ draftId }) }),
  reconcile: (id: string, outcome: 'sent' | 'cancelled') => request(`/outreach/${id}/reconcile`, { method: 'POST', body: JSON.stringify({ outcome }) }),
  schedule: () => request<Schedule>('/schedule'), saveSchedule: (value: Schedule) => request<Schedule>('/schedule', { method: 'PUT', body: JSON.stringify(value) }),
};
