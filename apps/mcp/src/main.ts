import { startMcp } from './index.js';
import { readStoredMcpToken } from '@gighunt/daemon';

const token = process.env.GIGHUNT_MCP_TOKEN ?? readStoredMcpToken();
if (!token) throw new Error('GigHunt MCP token not found. Start the daemon first.');
await startMcp({ baseUrl: process.env.GIGHUNT_URL ?? 'http://127.0.0.1:4317', token });
