import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const allowed = new Set(['API_TOKEN', 'MCP_TOKEN', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'HUNTER_API_KEY', 'GMAIL_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN_EXPIRES_AT', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
const environmentName = (name: string) => name === 'API_TOKEN' ? 'GIGHUNT_TOKEN' : name === 'MCP_TOKEN' ? 'GIGHUNT_MCP_TOKEN' : name;

function configDir() { return process.env.GIGHUNT_CONFIG_DIR ?? join(homedir(), '.config', 'gighunt'); }
function fallbackPath() { return join(configDir(), 'secrets.json'); }
function assertName(name: string) { if (!allowed.has(name)) throw new Error(`Unsupported secret name: ${name}`); }

function keychainRead(name: string): string | undefined {
  try {
    if (platform() === 'darwin') return execFileSync('security', ['find-generic-password', '-a', 'gighunt', '-s', `com.gighunt.${name}`, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    if (platform() === 'linux') return execFileSync('secret-tool', ['lookup', 'service', 'gighunt', 'name', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
  return undefined;
}

export function secretWriteCommand(name: string, operatingSystem = platform()): { file: string; args: string[] } | null {
  if (operatingSystem === 'darwin') return { file: 'security', args: ['add-generic-password', '-U', '-a', 'gighunt', '-s', `com.gighunt.${name}`, '-w'] };
  if (operatingSystem === 'linux') return { file: 'secret-tool', args: ['store', '--label=GigHunt secret', 'service', 'gighunt', 'name', name] };
  return null;
}

function keychainWrite(name: string, value: string): boolean {
  try {
    const command = secretWriteCommand(name); if (!command) return false;
    execFileSync(command.file, command.args, { input: value, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function fallbackRead(): Record<string, string> {
  try { return JSON.parse(readFileSync(fallbackPath(), 'utf8')) as Record<string, string>; } catch { return {}; }
}

export function loadSecret(name: string): string | undefined {
  assertName(name);
  const environment = process.env[environmentName(name)];
  if (environment) return environment;
  const keychain = keychainRead(name); if (keychain) return keychain;
  return platform() === 'win32' ? undefined : fallbackRead()[name];
}

export function saveSecret(name: string, value: string): { storage: 'keychain' | 'file' } {
  assertName(name);
  if (!value || /[\r\n]/.test(value)) throw new Error('Secret must be a non-empty single line');
  if (keychainWrite(name, value)) return { storage: 'keychain' };
  if (platform() === 'win32') throw new Error(`Windows credential storage is unavailable; provide ${environmentName(name)} in the daemon environment`);
  const path = fallbackPath(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const values = fallbackRead(); values[name] = value;
  writeFileSync(path, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  return { storage: 'file' };
}

export function hasSecret(name: string): boolean { return Boolean(loadSecret(name)); }
export function secretFallbackExists(): boolean { return existsSync(fallbackPath()); }
