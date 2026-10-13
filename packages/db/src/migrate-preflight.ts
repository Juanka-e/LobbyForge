/**
 * What the migrator checks before it changes anything.
 *
 * `lfctl update apply` runs the NEW image's migrator (same `.env.prod`)
 * before it recreates web and ws-gateway — even the previous release's
 * lfctl does. Since 0.2.0-rc.9 those refuse a published placeholder
 * `LOBBYFORGE_SESSION_SECRET`, so an update on one used to migrate the
 * database and only then fail with "container … is unhealthy" (rc.8 →
 * rc.9 drill). Refusing here stops the update before any schema change,
 * and lfctl prints the migrator's stderr.
 *
 * Only a secret that is SET is checked: the dev and CI migrators run
 * without one, and the migrator itself never signs anything.
 */
import { sessionSecretProblem } from '@lobbyforge/core';

/** The sentence to print and exit on, or null when migrating may go ahead. */
export function migrationPreflightRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (!env.LOBBYFORGE_SESSION_SECRET) return null;
  const problem = sessionSecretProblem(env);
  if (!problem) return null;
  const what =
    problem === 'placeholder'
      ? 'is a published placeholder (an example env file or the dev compose default)'
      : 'is shorter than 32 characters';
  return (
    `[db:migrate] refused: LOBBYFORGE_SESSION_SECRET ${what}, and this release's web and ws-gateway will not start with it. ` +
    'Nothing was migrated. Set a real one in .env.prod (openssl rand -hex 32; changing it signs everyone out), then run the update again.'
  );
}
