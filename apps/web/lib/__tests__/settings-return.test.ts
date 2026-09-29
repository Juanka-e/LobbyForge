import { describe, expect, it } from 'vitest';
import { isReturnPoint, parseReturnPath, settingsCloseTarget } from '../settings-return';

describe('settingsCloseTarget', () => {
  it('keeps the self-hosted contract: closing settings always goes to the lobby', () => {
    expect(settingsCloseTarget({ official: false, remembered: '/home' })).toBe('/lobby');
    expect(settingsCloseTarget({ official: false, remembered: null })).toBe('/lobby');
  });

  it('on the official hub, returns where the visitor came from', () => {
    expect(settingsCloseTarget({ official: true, remembered: '/home' })).toBe('/home');
    expect(settingsCloseTarget({ official: true, remembered: '/discover?q=owls' })).toBe('/discover?q=owls');
    // Opened from a real lobby: back to the same community.
    expect(settingsCloseTarget({ official: true, remembered: '/lobby?server=abc' })).toBe('/lobby?server=abc');
  });

  it('on the official hub, falls back to the hub home — never the demo lobby', () => {
    expect(settingsCloseTarget({ official: true, remembered: null })).toBe('/home');
    expect(settingsCloseTarget({ official: true, remembered: '' })).toBe('/home');
  });

  it('ignores a remembered value that is not a safe place to return to', () => {
    for (const bad of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/home\u0000',
      '/settings/profile',
      '/admin/settings',
      '/servers/abc',
      '/instances/new',
      '/login',
    ]) {
      expect(settingsCloseTarget({ official: true, remembered: bad }), bad).toBe('/home');
    }
  });
});

describe('isReturnPoint', () => {
  it('accepts pages people browse, and not the modal surfaces or flows', () => {
    expect(isReturnPoint('/home')).toBe(true);
    expect(isReturnPoint('/lobby')).toBe(true);
    expect(isReturnPoint('/discover/some-instance')).toBe(true);
    expect(isReturnPoint('/settings')).toBe(false);
    expect(isReturnPoint('/settings/appearance')).toBe(false);
    expect(isReturnPoint('/admin')).toBe(false);
    expect(isReturnPoint('/register')).toBe(false);
    // A similar name is still a page.
    expect(isReturnPoint('/settingsguide')).toBe(true);
  });
});

describe('parseReturnPath', () => {
  it('keeps the query string', () => {
    expect(parseReturnPath('/lobby?server=abc&dm=x')).toBe('/lobby?server=abc&dm=x');
  });

  it('refuses oversized values', () => {
    expect(parseReturnPath(`/${'a'.repeat(3000)}`)).toBeNull();
  });
});
