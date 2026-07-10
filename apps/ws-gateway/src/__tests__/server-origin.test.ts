import { describe, it, expect, afterEach } from 'vitest';
import { isAllowedWsOrigin } from '../server.js';

const envSnapshot = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

describe('isAllowedWsOrigin', () => {
  it('allows configured origins', () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOWED_ORIGINS = 'https://hub.lobbyforge.test, https://selfhost.example';
    expect(isAllowedWsOrigin('https://hub.lobbyforge.test/lobby')).toBe(true);
    expect(isAllowedWsOrigin('https://selfhost.example')).toBe(true);
  });

  it('rejects cross-origin browser connections in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOBBYFORGE_APP_ORIGIN = 'https://hub.lobbyforge.test';
    expect(isAllowedWsOrigin('https://evil.example')).toBe(false);
    expect(isAllowedWsOrigin(undefined)).toBe(false);
  });

  it('keeps localhost development ergonomic', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(isAllowedWsOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedWsOrigin(undefined)).toBe(true);
  });
});
