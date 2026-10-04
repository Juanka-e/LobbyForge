import { describe, expect, it } from 'vitest';
import { signInHref, signInReturnPath } from '../sign-in-return';

describe('signing in and coming back (?next=)', () => {
  it('keeps a same-origin path, query included', () => {
    expect(signInReturnPath('/settings/voice-video?tab=camera', '/lobby')).toBe('/settings/voice-video?tab=camera');
    expect(signInReturnPath('/room/abc', null)).toBe('/room/abc');
  });

  it('falls back for anything that could leave the site', () => {
    for (const raw of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'settings', '/%2F/evil.example']) {
      expect(signInReturnPath(raw, '/lobby')).toBe('/lobby');
    }
    expect(signInReturnPath(undefined, '/lobby')).toBe('/lobby');
    expect(signInReturnPath('', null)).toBeNull();
  });

  it('never sends a visitor back to a sign-in page', () => {
    expect(signInReturnPath('/login', '/lobby')).toBe('/lobby');
    expect(signInReturnPath('/login?next=/x', '/lobby')).toBe('/lobby');
    expect(signInReturnPath('/register', '/home')).toBe('/home');
    expect(signInReturnPath('/setup', null)).toBeNull();
    // …but a page that merely starts with those letters is fine.
    expect(signInReturnPath('/loginfo', '/lobby')).toBe('/loginfo');
  });

  it('builds the sign-in link with the page encoded', () => {
    expect(signInHref('/settings/notifications')).toBe('/login?next=%2Fsettings%2Fnotifications');
    expect(signInHref('/settings/voice-video?tab=camera')).toBe('/login?next=%2Fsettings%2Fvoice-video%3Ftab%3Dcamera');
    expect(signInHref('//evil.example')).toBe('/login');
    expect(signInHref('/login')).toBe('/login');
  });
});
