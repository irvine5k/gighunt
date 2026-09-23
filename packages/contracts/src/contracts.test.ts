import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { Profile, Settings } from './index.js';

describe('contracts', () => {
  it('accepts a confirmed profile', () => {
    expect(Value.Check(Profile, {
      id: 'default', name: 'Ada', email: 'ada@example.com', summary: 'Engineer', skills: ['TypeScript'],
      targetRoles: ['Staff Engineer'], locations: ['Remote'], remote: true, confirmed: true,
    })).toBe(true);
  });

  it('rejects unsafe limits', () => {
    expect(Value.Check(Settings, {
      approvalMode: 'automatic', jobsPerRun: 20, enrichmentsPerRun: 5, dailySendLimit: 101, paused: false,
    })).toBe(false);
  });
});
