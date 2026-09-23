# GigHunt

GigHunt runs on one person's computer. A loopback-only daemon owns the SQLite database, provider credentials, research queue, approval rules, and Gmail sending. The dashboard, CLI, and Codex/Claude MCP tools use its authenticated API. It is not a public hosted or multi-user service.

## Install

Use Node.js 24+ and pnpm 11+ to build from this checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
./dist/main.js --help
```

To use the built app from any directory, create and install a local npm tarball:

```bash
npm pack
npm install --global ./gighunt-0.1.0.tgz
gighunt --help
```

`better-sqlite3` needs its native install script. If pnpm blocks it during a source build, run `pnpm approve-builds`, approve `better-sqlite3`, then run `pnpm rebuild better-sqlite3` and rebuild GigHunt. If npm reports that the script was blocked after a tarball install, run `npm install-scripts ls`, approve `better-sqlite3` with `npm install-scripts approve better-sqlite3`, and run `npm rebuild better-sqlite3` in that installation context (use `--global` for a global install). The clean tarball smoke check required this approval on npm 11. Use the same Node.js major version for installation and execution.

## First run and local operation

Start with fake providers so no external calls or email are sent:

```bash
GIGHUNT_FAKE_PROVIDERS=true gighunt daemon
```

Open the one-time dashboard URL printed by the daemon. Confirm a profile, start a search, inspect a job and researched contact, then create and review a draft. Stop the daemon before switching to real providers. The daemon listens on `127.0.0.1:4317` by default; keep it bound to loopback and do not place a public proxy in front of it.

For ongoing use, run `gighunt daemon` as a service under your own OS account so it can access the same keychain and data directory. On Linux, a `systemd --user` service should use the absolute path to `gighunt` as `ExecStart`, set `Restart=on-failure`, and remain in your logged-in user session with Secret Service available. On macOS, use a user `launchd` agent; on Windows, use a per-user scheduled task. Keep the service output accessible: each daemon start prints a fresh one-time dashboard URL. Scheduled searches execute only while the daemon is running, and at most one catch-up run is created after downtime.

The default data directory is `~/.config/gighunt`. `GIGHUNT_CONFIG_DIR` changes it; `GIGHUNT_DB` selects a SQLite file. Stop the daemon before backing up or restoring the database, and copy the `.db` file together with any `-wal` and `-shm` files. Keep backups readable only by your OS account. The daemon creates separate human and MCP tokens; a legacy `token` file is imported once.

## Configure real providers

GigHunt uses OpenAI for extraction/drafting, Brave for public job discovery, Hunter for optional recruiter research, and Gmail for sending. Supply your own credentials through the OS secret store. For example, with values already held in shell variables:

```bash
printf %s "$OPENAI_API_KEY" | gighunt secret set OPENAI_API_KEY
printf %s "$BRAVE_API_KEY" | gighunt secret set BRAVE_API_KEY
printf %s "$HUNTER_API_KEY" | gighunt secret set HUNTER_API_KEY
```

Secrets are read from stdin, not command arguments. The CLI uses macOS Keychain or Linux Secret Service when available. On macOS/Linux, an owner-only `secrets.json` file is the fallback; protect and back it up accordingly. Windows has no file fallback: provide secrets through a protected service environment. Environment variables override stored secrets. The `.env.example` file is only a reference; GigHunt does not load it automatically. **Restart the daemon after setting or changing provider credentials**, because it creates provider clients at startup.

For unattended Gmail sending, enable the Gmail API in a Google Cloud project, create a desktop OAuth client, and obtain a refresh token with the `https://www.googleapis.com/auth/gmail.send` scope and offline access using your own OAuth flow. GigHunt does not perform interactive OAuth authorization. Store `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` with `gighunt secret set` as above. The daemon refreshes access tokens and stores their expiry; a standalone `GMAIL_ACCESS_TOKEN` expires and is unsuitable for a persistent service. Restart after adding these values. Gmail timeouts or crashes during dispatch become `uncertain` and require a human to check Sent mail and reconcile the record; GigHunt will not retry them automatically.

Before a first real send, switch to individual approval, set the daily send limit to 1, verify the job, recruiter evidence, exact recipient, and draft in the dashboard, then explicitly approve and send. Check Gmail Sent and GigHunt history afterward. Hunter requests count against the per-run enrichment budget even when the provider fails or a worker retries. If Hunter is not configured, jobs remain available but enriched recruiter contacts are not produced. Hunter's email-source URLs are kept as email evidence; they do not prove recruiter affiliation. The Hunter adapter therefore leaves affiliation unconfirmed and cannot qualify those contacts for automatic sending by itself.

## CLI and MCP

Keep the daemon running, then use the installed CLI:

```bash
gighunt profile get
gighunt run start 'staff typescript engineer remote'
gighunt jobs list
gighunt jobs research-contact JOB_ID
gighunt contacts list --job JOB_ID
gighunt contacts show CONTACT_ID
gighunt draft create --job JOB_ID --contact CONTACT_ID
gighunt outreach approve DRAFT_ID
gighunt outreach send DRAFT_ID
gighunt pause
```

Get `CONTACT_ID` from `gighunt contacts list --job JOB_ID`, the dashboard, or MCP. The CLI reads the human daemon token from local secret storage. `GIGHUNT_URL` changes the loopback daemon URL; `GIGHUNT_TOKEN` overrides token discovery.

Configure Codex or Claude to launch a local stdio MCP process with command `gighunt` and argument `mcp`, under the same OS account. Set `GIGHUNT_URL` if you changed the port. MCP can search jobs, queue contact research, use `gighunt_contacts_list` and `gighunt_contact_get` to obtain a contact ID and evidence, create or edit drafts, view history, and manage schedules. It uses a separate scoped token and cannot approve drafts, confirm recruiter affiliation, or reconcile uncertain sends. Use the dashboard for affiliation confirmation; the dashboard or CLI can approve and reconcile.

## Safeguards and verification

Editing a draft creates a new revision and invalidates its prior approval. Sending rechecks pause, suppression, approval, duplicate outreach, and the daily limit before Gmail I/O. Automatic sending requires a verified email, human-confirmed recruiter affiliation, and a constrained template; start with individual approval. Public page fetching blocks private network targets and treats page content as untrusted.

The research queue and outreach history persist in SQLite. To verify a source build, run `pnpm typecheck`, `pnpm test`, and `pnpm build`. The automated checks cover budget reservations and retries, contact lookup, CLI symlinks, queue recovery, approval and send rules, daemon authentication, provider adapters, and dashboard flows. Live OpenAI, Brave, Hunter, and Gmail calls require your credentials and are not part of the automated checks.
