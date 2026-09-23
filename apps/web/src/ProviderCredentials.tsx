import { useEffect, useState, type FormEvent } from 'react';
import type { ProviderCredentialName, ProviderCredentialStatus } from '@gighunt/contracts';
import { api } from './api.js';

const fields: Array<{ name: ProviderCredentialName; label: string; hint: string }> = [
  { name: 'BRAVE_API_KEY', label: 'Brave Search API key', hint: 'Required to discover positions.' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key', hint: 'Required to extract job details and create reviewed drafts.' },
  { name: 'HUNTER_API_KEY', label: 'Hunter API key', hint: 'Optional recruiter contact research.' },
  { name: 'GMAIL_CLIENT_ID', label: 'Gmail OAuth client ID', hint: 'Desktop OAuth client for sending.' },
  { name: 'GMAIL_CLIENT_SECRET', label: 'Gmail OAuth client secret', hint: 'Stored with your other local credentials.' },
  { name: 'GMAIL_REFRESH_TOKEN', label: 'Gmail refresh token', hint: 'Requires offline access and the gmail.send scope.' },
];

export function ProviderCredentials() {
  const [statuses, setStatuses] = useState<ProviderCredentialStatus[]>([]);
  const [values, setValues] = useState<Partial<Record<ProviderCredentialName, string>>>({});
  const [saving, setSaving] = useState<ProviderCredentialName | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    api.providerCredentials().then((items) => { if (active) setStatuses(items); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load credential status'); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>, name: ProviderCredentialName) {
    event.preventDefault();
    const value = values[name]?.trim(); if (!value) return;
    setSaving(name); setError(''); setNotice('');
    try {
      const status = await api.saveProviderCredential(name, value);
      setStatuses((items) => items.map((item) => item.name === name ? status : item));
      setValues((items) => ({ ...items, [name]: '' }));
      setNotice(`${name} saved. New work will use it immediately.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save credential');
    } finally { setSaving(null); }
  }

  return <section className="provider-credentials">
    <h2>Provider credentials</h2>
    <p className="muted">Values stay in your local credential store. GigHunt shows only whether each value is configured. Saving a value updates the running agent for new work.</p>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <p className="credential-notice" role="status">{notice}</p>}
    {fields.map(({ name, label, hint }) => {
      const status = statuses.find((item) => item.name === name);
      return <form className="credential-row" key={name} onSubmit={(event) => void save(event, name)}>
        <div className="credential-heading"><strong>{label}</strong><span>{status ? status.configured ? 'Configured' : 'Not configured' : 'Checking…'}</span></div>
        <p className="muted">{hint}{status?.managedExternally ? ' Managed by the daemon environment.' : ''}</p>
        {!status?.managedExternally && <div className="credential-entry"><input type="password" aria-label={label} autoComplete="off" spellCheck={false} value={values[name] ?? ''} onChange={(event) => setValues((items) => ({ ...items, [name]: event.target.value }))} placeholder={status?.configured ? 'Enter a replacement value' : 'Enter value'} required /><button disabled={saving !== null || !status}>Save</button></div>}
      </form>;
    })}
  </section>;
}
