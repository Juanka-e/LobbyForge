/**
 * security-review INFRA-V-02: the gateway process refuses to start with a
 * published placeholder session secret (the dev compose default, the
 * .env.example value) unless it runs in the local dev stack
 * (LOBBYFORGE_DEV_STACK=true). `createGateway` is faked so nothing listens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createGateway = vi.fn(() => ({ wss: { address: () => null }, close: async () => {} }));
vi.mock('../server.js', () => ({ createGateway }));

const saved = { secret: process.env.LOBBYFORGE_SESSION_SECRET, devStack: process.env.LOBBYFORGE_DEV_STACK };

beforeEach(() => {
  vi.resetModules();
  createGateway.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(process, 'on').mockImplementation((() => process) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.secret === undefined) delete process.env.LOBBYFORGE_SESSION_SECRET;
  else process.env.LOBBYFORGE_SESSION_SECRET = saved.secret;
  if (saved.devStack === undefined) delete process.env.LOBBYFORGE_DEV_STACK;
  else process.env.LOBBYFORGE_DEV_STACK = saved.devStack;
});

describe('gateway startup secret check', () => {
  it('exits before listening when the secret is the dev compose placeholder', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = 'dev_session_secret_change_before_public_use_1234';
    delete process.env.LOBBYFORGE_DEV_STACK;
    await expect(import('../index.js')).rejects.toThrow('process.exit(1)');
    expect(createGateway).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/published placeholder/));
  });

  it('exits when the secret is missing', async () => {
    delete process.env.LOBBYFORGE_SESSION_SECRET;
    await expect(import('../index.js')).rejects.toThrow('process.exit(1)');
    expect(createGateway).not.toHaveBeenCalled();
  });

  it('starts in the dev stack with the dev compose placeholder', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = 'dev_session_secret_change_before_public_use_1234';
    process.env.LOBBYFORGE_DEV_STACK = 'true';
    await import('../index.js');
    expect(createGateway).toHaveBeenCalledTimes(1);
  });

  it('starts with a real secret', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = 'a3f9'.repeat(16);
    delete process.env.LOBBYFORGE_DEV_STACK;
    await import('../index.js');
    expect(createGateway).toHaveBeenCalledTimes(1);
  });
});
