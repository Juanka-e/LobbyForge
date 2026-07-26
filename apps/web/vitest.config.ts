import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./'),
    },
  },
  esbuild: {
    // Match Next.js's automatic JSX runtime so component tests don't need
    // an explicit `import React from 'react'`.
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/__tests__/**/*.test.ts',
      'lib/__tests__/**/*.test.ts',
      'app/api/**/__tests__/**/*.test.ts',
      // React component tests (opt into happy-dom per-file via docblock).
      'app/**/__tests__/**/*.test.tsx',
      'components/**/__tests__/**/*.test.tsx',
    ],
  },
});
