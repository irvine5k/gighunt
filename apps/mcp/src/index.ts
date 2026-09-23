import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GigHuntClient } from '@gighunt/contracts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

export function createMcp(options: { baseUrl: string; token: string }) {
  const client = new GigHuntClient(options.baseUrl, options.token);
  const server = new McpServer({ name: 'gighunt', version: '0.1.0' });
  server.registerTool('gighunt_profile_get', { description: 'Read the job-seeker profile' }, async () => text(await client.get('/profile')));
  server.registerTool('gighunt_profile_update', { description: 'Prepare or update the job-seeker profile', inputSchema: {
    name: z.string(), email: z.string().email(), summary: z.string(), skills: z.array(z.string()), targetRoles: z.array(z.string()), locations: z.array(z.string()), remote: z.boolean(), confirmed: z.literal(false),
  } }, async (input) => text(await client.put('/profile', input)));
  server.registerTool('gighunt_runs_list', { description: 'List job research runs' }, async () => text(await client.get('/runs')));
  server.registerTool('gighunt_run_start', { description: 'Start a job research run', inputSchema: { query: z.string().min(2) } }, async ({ query }) => text(await client.post('/runs', { query })));
  server.registerTool('gighunt_run_get', { description: 'Read one research run', inputSchema: { runId: z.string().min(1) } }, async ({ runId }) => text(await client.get(`/runs/${runId}`)));
  server.registerTool('gighunt_jobs_list', { description: 'List ranked jobs and evidence' }, async () => text(await client.get('/jobs')));
  server.registerTool('gighunt_job_get', { description: 'Read one ranked job and its evidence', inputSchema: { jobId: z.string().min(1) } }, async ({ jobId }) => text(await client.get(`/jobs/${jobId}`)));
  server.registerTool('gighunt_contact_research', { description: 'Queue recruiter contact research for a job', inputSchema: { jobId: z.string() } }, async ({ jobId }) => text(await client.post(`/jobs/${jobId}/research-contact`)));
  server.registerTool('gighunt_contacts_list', { description: 'List researched recruiter contacts; filter by job to obtain a contactId for drafting', inputSchema: { jobId: z.string().min(1).optional() } }, async ({ jobId }) => text(await client.get(`/contacts${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`)));
  server.registerTool('gighunt_contact_get', { description: 'Read one recruiter contact and its evidence', inputSchema: { contactId: z.string().min(1) } }, async ({ contactId }) => text(await client.get(`/contacts/${encodeURIComponent(contactId)}`)));
  server.registerTool('gighunt_draft_create', { description: 'Create a grounded outreach draft', inputSchema: { jobId: z.string(), contactId: z.string() } }, async (input) => text(await client.post('/drafts', input)));
  server.registerTool('gighunt_draft_update', { description: 'Save draft edits as a new unapproved revision', inputSchema: { draftId: z.string().min(1), subject: z.string().min(1), body: z.string().min(1) } }, async ({ draftId, subject, body }) => text(await client.put(`/drafts/${draftId}`, { subject, body })));
  server.registerTool('gighunt_outreach_send', { description: 'Queue an already human-approved or automatic-policy-qualified outreach message', inputSchema: { draftId: z.string() } }, async ({ draftId }) => text(await client.post('/outreach/send', { draftId })));
  server.registerTool('gighunt_outreach_history', { description: 'List send history and uncertain outcomes' }, async () => text(await client.get('/outreach')));
  server.registerTool('gighunt_schedule_get', { description: 'Read the local search schedule' }, async () => text(await client.get('/schedule')));
  server.registerTool('gighunt_schedule_update', { description: 'Update the local search schedule', inputSchema: { enabled: z.boolean(), cron: z.string(), timezone: z.string(), lastRunAt: z.string().nullable() } }, async (input) => text(await client.put('/schedule', input)));
  server.registerTool('gighunt_pause', { description: 'Pause all agent work and sends' }, async () => text(await client.post('/pause')));
  server.registerTool('gighunt_resume', { description: 'Resume agent work' }, async () => text(await client.post('/resume')));
  return server;
}

export async function startMcp(options: { baseUrl: string; token: string }) { const server = createMcp(options); await server.connect(new StdioServerTransport()); }
