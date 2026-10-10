import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./'),
    },
  },
  oxc: {
    // Match Next.js's automatic JSX runtime so component tests don't need
    // an explicit `import React from 'react'`. (Vite 8 transforms with Oxc;
    // this was `esbuild: { jsx: 'automatic' }` on Vite 6.)
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/__tests__/**/*.test.ts',
      'lib/__tests__/**/*.test.ts',
      // Nested helper suites, e.g. lib/i18n/__tests__.
      'lib/**/__tests__/**/*.test.ts',
      'lib/**/__tests__/**/*.test.tsx',
      'app/api/**/__tests__/**/*.test.ts',
      // React component tests (opt into happy-dom per-file via docblock).
      'app/**/__tests__/**/*.test.tsx',
      'components/**/__tests__/**/*.test.tsx',
    ],
  },
});
