import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSecret, saveSecret } from './secrets.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local credential file', () => {
  it('stores multiple secrets without exposing them through world-readable permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-secrets-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('GIGHUNT_CONFIG_DIR', directory);
    vi.stubEnv('BRAVE_API_KEY', undefined);
    vi.stubEnv('HUNTER_API_KEY', undefined);
    expect(saveSecret('BRAVE_API_KEY', 'brave=value#1')).toEqual({ storage: 'file' });
    saveSecret('HUNTER_API_KEY', 'hunter=value#2');
    expect(loadSecret('BRAVE_API_KEY')).toBe('brave=value#1');
    expect(loadSecret('HUNTER_API_KEY')).toBe('hunter=value#2');
    const path = join(directory, '.env.local');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('BRAVE_API_KEY="brave=value#1"');
  });

  it('lets an explicit process environment override the local file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-secrets-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('GIGHUNT_CONFIG_DIR', directory);
    vi.stubEnv('BRAVE_API_KEY', undefined);
    saveSecret('BRAVE_API_KEY', 'stored');
    vi.stubEnv('BRAVE_API_KEY', 'external');
    expect(loadSecret('BRAVE_API_KEY')).toBe('external');
  });
});
