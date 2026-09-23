// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { App } from './App.js';

vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Authentication required' } }) })));

it('starts with grounded profile onboarding', () => {
  render(<App />);
  expect(screen.getByText('Teach your search agent what matters.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm profile' })).toBeInTheDocument();
});
