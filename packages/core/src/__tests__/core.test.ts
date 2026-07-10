import { describe, it, expect } from 'vitest';
import { UserRole, hasRole, LobbyForgeError, buildHealthStatus } from '../index.js';

describe('@lobbyforge/core', () => {
  it('compares roles by hierarchy', () => {
    expect(hasRole(UserRole.OWNER, UserRole.GUEST)).toBe(true);
    expect(hasRole(UserRole.MODERATOR, UserRole.ADMIN)).toBe(false);
    expect(hasRole(UserRole.GUEST, UserRole.GUEST)).toBe(true);
  });

  it('LobbyForgeError exposes a code', () => {
    const err = new LobbyForgeError('boom', 'E_BOOM');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('E_BOOM');
    expect(err.message).toBe('boom');
  });

  it('buildHealthStatus aggregates checks and uptime', () => {
    const status = buildHealthStatus({ db: true, redis: true }, new Date(Date.now() - 2000));
    expect(status.ok).toBe(true);
    expect(status.checks).toEqual({ db: true, redis: true });
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(1);
  });

  it('buildHealthStatus is not ok if any check fails', () => {
    const status = buildHealthStatus({ db: true, redis: false });
    expect(status.ok).toBe(false);
  });
});
