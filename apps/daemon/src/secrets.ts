import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const allowed = new Set(['API_TOKEN', 'MCP_TOKEN', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'HUNTER_API_KEY', 'GMAIL_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN_EXPIRES_AT', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
const environmentName = (name: string) => name === 'API_TOKEN' ? 'GIGHUNT_TOKEN' : name === 'MCP_TOKEN' ? 'GIGHUNT_MCP_TOKEN' : name;

function configDir() { return process.env.GIGHUNT_CONFIG_DIR ?? join(homedir(), '.config', 'gighunt'); }
function localEnvPath() { return join(configDir(), '.env.local'); }
function fallbackPath() { return join(configDir(), 'secrets.json'); }
function assertName(name: string) { if (!allowed.has(name)) throw new Error(`Unsupported secret name: ${name}`); }

function keychainRead(name: string): string | undefined {
  try {
    if (platform() === 'darwin') return execFileSync('security', ['find-generic-password', '-a', 'gighunt', '-s', `com.gighunt.${name}`, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || undefined;
    if (platform() === 'linux') return execFileSync('secret-tool', ['lookup', 'service', 'gighunt', 'name', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || undefined;
  } catch { return undefined; }
  return undefined;
}

function parseLocalEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !allowed.has(match[1]!)) continue;
    const raw = match[2]!;
    if (raw.startsWith('"')) {
      try { const value = JSON.parse(raw); if (typeof value === 'string') values[match[1]!] = value; } catch { /* Ignore malformed values. */ }
    } else if (raw) values[match[1]!] = raw;
  }
  return values;
}

function localEnvRead(): Record<string, string> {
  try { return parseLocalEnv(readFileSync(localEnvPath(), 'utf8')); } catch { return {}; }
}

function fallbackRead(): Record<string, string> {
  try { return JSON.parse(readFileSync(fallbackPath(), 'utf8')) as Record<string, string>; } catch { return {}; }
}

export function loadSecret(name: string): string | undefined {
  assertName(name);
  const environment = process.env[environmentName(name)];
  if (environment) return environment;
  const local = localEnvRead()[name]; if (local) return local;
  const legacy = fallbackRead()[name]; if (legacy) return legacy;
  return keychainRead(name);
}

export function saveSecret(name: string, value: string): { storage: 'file' } {
  assertName(name);
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Secret must be a non-empty single line');
  const path = localEnvPath(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const values = localEnvRead(); values[name] = value;
  const contents = Object.entries(values).map(([key, secret]) => `${key}=${JSON.stringify(secret)}`).join('\n') + '\n';
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No temporary file to clean up. */ }
    throw error;
  }
  return { storage: 'file' };
}

export function hasSecret(name: string): boolean { return Boolean(loadSecret(name)); }
export function secretFallbackExists(): boolean { return existsSync(localEnvPath()) || existsSync(fallbackPath()); }
