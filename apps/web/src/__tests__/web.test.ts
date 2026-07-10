import { describe, it, expect } from 'vitest';
import { APP_NAME, APP_VERSION, findRouteByPath, ROUTES } from '../index.js';

describe('@lobbyforge/web', () => {
  it('exposes app metadata', () => {
    expect(APP_NAME).toBe('LobbyForge Web');
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('findRouteByPath resolves known paths', () => {
    expect(findRouteByPath('/login')?.title).toBe('Login');
    expect(findRouteByPath('/does-not-exist')).toBeUndefined();
  });

  it('ROUTES marks auth-required pages', () => {
    expect(ROUTES.home.requiresAuth).toBe(false);
    expect(ROUTES.dashboard.requiresAuth).toBe(true);
  });
});
