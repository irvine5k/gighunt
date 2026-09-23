import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    environment: 'node',
    coverage: { reporter: ['text', 'json-summary'] },
  },
});
