import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, normalizeEmail, scoreJob } from './index.js';

describe('domain', () => {
  it('normalizes identity inputs', () => {
    expect(normalizeEmail(' Recruiter@Example.COM ')).toBe('recruiter@example.com');
    expect(canonicalizeUrl('https://EXAMPLE.com/jobs/1/?utm_source=x#apply')).toBe('https://example.com/jobs/1');
  });

  it('scores only explicit matches and labels the rest unknown', () => {
    expect(scoreJob({ skills: ['TypeScript'], targetRoles: ['Engineer'], locations: [], remote: true }, {
      url: 'https://example.com/1', title: 'Engineer', company: 'Acme', location: 'Remote', description: 'TypeScript',
    })).toEqual({ score: 70, rationale: '1 skill matches; role matches; location matches' });
  });
});
