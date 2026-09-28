import { describe, expect, it } from 'vitest';
import { isAppHeaderHidden } from '../hub-chrome';

describe('isAppHeaderHidden', () => {
  it('steps aside for pages with their own chrome, on any deployment', () => {
    for (const official of [true, false]) {
      for (const path of ['/landing', '/home', '/download', '/marketplace', '/login', '/register', '/setup']) {
        expect(isAppHeaderHidden(path, official), `${path} official=${official}`).toBe(true);
      }
      for (const path of ['/lobby', '/admin/settings/roles', '/settings/profile', '/servers/abc']) {
        expect(isAppHeaderHidden(path, official), `${path} official=${official}`).toBe(true);
      }
    }
  });

  it('steps aside for the hub pages on the official hub', () => {
    for (const path of ['/discover', '/discover/instance-1', '/discover/go', '/instances/new', '/connect']) {
      expect(isAppHeaderHidden(path, true), path).toBe(true);
    }
  });

  it('keeps the header on a self-hosted instance’s connect page', () => {
    expect(isAppHeaderHidden('/connect', false)).toBe(false);
  });

  it('keeps the header on the connect developer demo and other app pages', () => {
    expect(isAppHeaderHidden('/connect/demo', true)).toBe(false);
    expect(isAppHeaderHidden('/join/ABCD2345EFGH', true)).toBe(false);
    expect(isAppHeaderHidden('/room/main', false)).toBe(false);
    // Not a hub page, just a similar name.
    expect(isAppHeaderHidden('/discoveries', true)).toBe(false);
  });

  it('shows the header while the path is unknown', () => {
    expect(isAppHeaderHidden(null, true)).toBe(false);
  });
});
