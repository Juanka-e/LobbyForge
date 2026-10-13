/**
 * The migrator refuses a session secret this release's web and ws-gateway
 * would refuse, before it touches the database (rc.8 → rc.9 drill: the
 * update migrated, then failed on "container … is unhealthy").
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { migrationPreflightRefusal } from '../migrate-preflight.js';

const REAL = '3f9a1c7e5b2d48a6c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7';

describe('migrationPreflightRefusal', () => {
  it('lets the migrator run without a secret (dev, CI) and with a real one', () => {
    expect(migrationPreflightRefusal({})).toBeNull();
    expect(migrationPreflightRefusal({ LOBBYFORGE_SESSION_SECRET: '' })).toBeNull();
    expect(migrationPreflightRefusal({ LOBBYFORGE_SESSION_SECRET: REAL })).toBeNull();
  });

  it('refuses a published placeholder, unless the dev stack declares itself', () => {
    for (const secret of [
      'replace_me_with_at_least_32_chars_of_random_hex',
      'CHANGE_ME_64_char_hex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'dev_session_secret_change_before_public_use_1234',
    ]) {
      const refusal = migrationPreflightRefusal({ LOBBYFORGE_SESSION_SECRET: secret });
      expect(refusal).toContain('published placeholder');
      expect(refusal).toContain('Nothing was migrated');
      expect(refusal).not.toContain(secret);
      expect(migrationPreflightRefusal({ LOBBYFORGE_SESSION_SECRET: secret, LOBBYFORGE_DEV_STACK: 'true' })).toBeNull();
    }
  });

  it('refuses a secret that is too short', () => {
    expect(migrationPreflightRefusal({ LOBBYFORGE_SESSION_SECRET: '0123456789abcdef' })).toContain('shorter than 32 characters');
  });

  it('the built migrator exits 1 with the reason before it connects', () => {
    const res = spawnSync(process.execPath, [join(__dirname, '..', '..', 'dist', 'migrate.js')], {
      cwd: join(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        LOBBYFORGE_DEV_STACK: '',
        LOBBYFORGE_SESSION_SECRET: 'replace_me_with_at_least_32_chars_of_random_hex',
        // Nothing listens here: a connection attempt would fail differently.
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      },
    });
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('[db:migrate] refused');
    expect(res.stderr).not.toContain('ECONNREFUSED');
  });
});
