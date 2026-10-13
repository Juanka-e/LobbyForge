import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isDevStack,
  isPlaceholderSessionSecret,
  requireSessionSecret,
  sessionSecretProblem,
} from '../session-secret.js';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const REAL = 'f3a9c0d2e8b14a7f9c6d5e4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a49';

/** Every LOBBYFORGE_SESSION_SECRET value published in the repo's env examples and the dev compose. */
function publishedSecrets(): string[] {
  const files = [
    'infra/docker/.env.example',
    'infra/docker/.env.prod.example',
    'infra/docker/docker-compose.dev.yml',
  ];
  const values: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of text.matchAll(/LOBBYFORGE_SESSION_SECRET(?:=|:\s*\$\{LOBBYFORGE_SESSION_SECRET:-)([^\s}]+)/g)) {
      values.push(match[1]!);
    }
  }
  return values;
}

describe('session secret (security-review INFRA-V-02)', () => {
  it('accepts a random secret of 32+ characters', () => {
    expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: REAL })).toBeNull();
    expect(requireSessionSecret({ LOBBYFORGE_SESSION_SECRET: REAL })).toBe(REAL);
  });

  it('refuses a missing or short secret, dev stack or not', () => {
    expect(sessionSecretProblem({})).toBe('missing');
    expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: 'short' })).toBe('too_short');
    expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: 'short', LOBBYFORGE_DEV_STACK: 'true' })).toBe('too_short');
    expect(() => requireSessionSecret({})).toThrow(/at least 32 characters/);
  });

  it('refuses every placeholder the repository publishes', () => {
    const published = publishedSecrets();
    // .env.example, .env.prod.example, and the dev compose (web + ws-gateway).
    expect(published.length).toBeGreaterThanOrEqual(4);
    for (const value of published) {
      expect(isPlaceholderSessionSecret(value), value).toBe(true);
      expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: value }), value).not.toBeNull();
    }
    expect(() =>
      requireSessionSecret({ LOBBYFORGE_SESSION_SECRET: 'dev_session_secret_change_before_public_use_1234' })
    ).toThrow(/published placeholder/);
    expect(() =>
      requireSessionSecret({ LOBBYFORGE_SESSION_SECRET: 'replace_me_with_at_least_32_chars_of_random_hex' })
    ).toThrow(/randomBytes/);
  });

  it('refuses obvious placeholder shapes too', () => {
    for (const value of [
      '<at least 32 chars of random hex here>',
      'CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME',
      'your-session-secret-goes-here-0123456789',
      'placeholder-placeholder-placeholder-00',
    ]) {
      expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: value }), value).toBe('placeholder');
    }
  });

  it('allows a placeholder only when the dev stack flag is exactly "true"', () => {
    const secret = 'dev_session_secret_change_before_public_use_1234';
    expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: secret, LOBBYFORGE_DEV_STACK: 'true' })).toBeNull();
    expect(requireSessionSecret({ LOBBYFORGE_SESSION_SECRET: secret, LOBBYFORGE_DEV_STACK: 'true' })).toBe(secret);
    for (const flag of ['1', 'yes', 'TRUE', 'false', '']) {
      expect(sessionSecretProblem({ LOBBYFORGE_SESSION_SECRET: secret, LOBBYFORGE_DEV_STACK: flag }), flag).toBe('placeholder');
    }
    expect(isDevStack({ LOBBYFORGE_DEV_STACK: 'true' })).toBe(true);
    expect(isDevStack({})).toBe(false);
  });

  it('only the dev compose sets the dev stack flag — never the production compose or its example env', () => {
    const dev = readFileSync(join(REPO_ROOT, 'infra/docker/docker-compose.dev.yml'), 'utf8');
    // web and ws-gateway both verify cookies.
    expect(dev.match(/LOBBYFORGE_DEV_STACK: "true"/g)?.length).toBe(2);
    for (const file of ['infra/docker/docker-compose.prod.yml', 'infra/docker/.env.prod.example', 'install.sh']) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8'), file).not.toContain('LOBBYFORGE_DEV_STACK');
    }
  });
});
