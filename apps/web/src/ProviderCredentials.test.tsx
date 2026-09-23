// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { ProviderCredentials } from './ProviderCredentials.js';

vi.mock('./api.js', () => ({ api: { providerCredentials: vi.fn(), saveProviderCredential: vi.fn() } }));

beforeEach(() => {
  vi.mocked(api.providerCredentials).mockResolvedValue([
    { name: 'BRAVE_API_KEY', configured: false, managedExternally: false },
    { name: 'OPENAI_API_KEY', configured: true, managedExternally: false },
  ]);
  vi.mocked(api.saveProviderCredential).mockResolvedValue({ name: 'BRAVE_API_KEY', configured: true, managedExternally: false });
});

it('saves a provider key, clears the input, and shows only configuration status', async () => {
  render(<ProviderCredentials />);
  const braveInput = await screen.findByLabelText('Brave Search API key');
  await waitFor(() => expect(braveInput.closest('form')!.querySelector('button')).toBeEnabled());
  fireEvent.change(braveInput, { target: { value: 'test-brave-key' } });
  fireEvent.submit(braveInput.closest('form')!);
  await waitFor(() => expect(api.saveProviderCredential).toHaveBeenCalledWith('BRAVE_API_KEY', 'test-brave-key'));
  await waitFor(() => expect(braveInput).toHaveValue(''));
  expect(screen.getByRole('status')).toHaveTextContent('saved');
  expect(screen.queryByText('test-brave-key')).not.toBeInTheDocument();
});
