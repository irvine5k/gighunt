import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildProgram, isEntrypoint, secretFromInput } from './main.js';

describe('CLI secret input', () => {
  it('reads secret values from stdin and never defines an argv value argument', async () => {
    expect(await secretFromInput(Readable.from(['sensitive-value\n']))).toBe('sensitive-value');
    const secret = buildProgram().commands.find((command) => command.name() === 'secret')!;
    const set = secret.commands.find((command) => command.name() === 'set')!;
    expect(set.registeredArguments.map((argument) => argument.name())).toEqual(['name']);
  });
});

describe('CLI entrypoint', () => {
  it('recognizes an npm-style symlink to the executable while remaining safe to import', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gighunt-bin-'));
    const executable = new URL('./main.ts', import.meta.url);
    const link = join(directory, 'gighunt');
    try {
      symlinkSync(fileURLToPath(executable), link);
      expect(isEntrypoint(executable.href, link)).toBe(true);
      expect(isEntrypoint(executable.href, fileURLToPath(import.meta.url))).toBe(false);
      expect(isEntrypoint(executable.href, undefined)).toBe(false);
      expect(buildProgram().name()).toBe('gighunt');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CLI contacts', () => {
  it('lists contacts by job and reads contact evidence through the authenticated API client', async () => {
    const jobId = 'job-123'; const contactId = 'contact-456';
    const paths: string[] = [];
    vi.stubEnv('GIGHUNT_TOKEN', 'secret');
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const url = new URL(input); paths.push(`${url.pathname}${url.search}`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return new Response(JSON.stringify({ id: contactId, jobId, emailEvidence: 'Published email' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await buildProgram().parseAsync(['contacts', 'list', '--job', jobId], { from: 'user' });
      await buildProgram().parseAsync(['contacts', 'show', contactId], { from: 'user' });
      expect(paths).toEqual([`/api/v1/contacts?jobId=${jobId}`, `/api/v1/contacts/${contactId}`]);
      expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain('Published email');
    } finally {
      write.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });
});
