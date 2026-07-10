import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',
      'lib/__tests__/**/*.test.ts',
      'app/api/**/__tests__/**/*.test.ts',
    ],
  },
});
