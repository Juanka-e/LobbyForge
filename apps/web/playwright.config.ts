import { defineConfig, devices } from '@playwright/test';

// LF-023: when LF_E2E_BASE_URL is set the tests run against an
// EXTERNAL stack (docker compose with real Postgres/Redis/LiveKit —
// the CI e2e job). No dev server is started in that mode; the compose
// stack under test is expected to be up already.
const externalBaseUrl = process.env.LF_E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: externalBaseUrl ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @lobbyforge/web dev',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 120000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],
});
