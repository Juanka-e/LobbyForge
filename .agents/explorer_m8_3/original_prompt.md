## 2026-06-10T13:40:50Z

Analyze the API routes in `apps/web` (specifically `/api/auth/guest`, `/api/servers`, and the `probePostgres` function in `apps/web/lib/doctor.ts`). Identify if they currently have mocks or if there are other areas to hook up. Investigate how we can verify database connections, schema queries, and migration execution through unit or integration tests, and check where existing tests are run. Write your findings to `.agents/explorer_m8_3/analysis.md`.
