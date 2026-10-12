import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src/', import.meta.url)).replace(/\\/g, '/');

export default defineConfig({
  resolve: {
    // The examples import the BUILT package (`../dist/*.js` — what a user
    // runs); their tests load the sources instead, so no build is needed.
    alias: [{ find: /^\.\.\/dist\/(.+)\.js$/, replacement: `${src}$1.ts` }],
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
