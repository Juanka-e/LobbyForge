import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireTestResetAccess, TEST_RESET_HEADER } from '../test-reset-auth.js';

describe('test reset authentication', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is unavailable outside test mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(requireTestResetAccess(new Request('http://localhost/api/test/db-reset'))?.status).toBe(403);
  });

  it('fails closed when the reset token is missing or weak', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LOBBYFORGE_TEST_RESET_TOKEN', 'short');
    const req = new Request('http://localhost/api/test/db-reset', {
      headers: { [TEST_RESET_HEADER]: 'short' },
    });
    expect(requireTestResetAccess(req)?.status).toBe(403);
  });

  it('accepts only the exact strong reset token in test mode', () => {
    const token = 'r'.repeat(48);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LOBBYFORGE_TEST_RESET_TOKEN', token);
    const exact = new Request('http://localhost/api/test/db-reset', {
      headers: { [TEST_RESET_HEADER]: token },
    });
    const wrong = new Request('http://localhost/api/test/db-reset', {
      headers: { [TEST_RESET_HEADER]: `${token.slice(0, -1)}x` },
    });
    expect(requireTestResetAccess(exact)).toBeNull();
    expect(requireTestResetAccess(wrong)?.status).toBe(403);
  });
});
