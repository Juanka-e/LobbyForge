import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_FRAME_SANDBOX,
  FILES_FRAME_SANDBOX,
  appOrigins,
  configuredAppOrigins,
  externalUiOrigin,
  isCspOrigin,
  pluginFrameSrc,
} from '../plugin-frame-target';

/**
 * Where a marketplace plugin's frame points (phase 2 of the plugin unlock):
 * an external UI is framed with allow-same-origin, so it must never sit on
 * the app's own address.
 */
describe('externalUiOrigin', () => {
  const APP = ['https://chat.example.com'];

  it('returns the origin of a site on another host', () => {
    expect(externalUiOrigin('https://game.example.net/play?room=1', APP)).toBe('https://game.example.net');
    expect(externalUiOrigin('https://game.example.net:8443/', APP)).toBe('https://game.example.net:8443');
    // A sibling subdomain is another host (the owner approved it by name).
    expect(externalUiOrigin('https://game.example.com/', APP)).toBe('https://game.example.com');
    // No app origin known: nothing to compare with.
    expect(externalUiOrigin('https://game.example.net/', [])).toBe('https://game.example.net');
  });

  it('refuses the app’s own origin, its host on another port or scheme, and subdomains either way', () => {
    for (const url of [
      'https://chat.example.com/uploads/page.html',
      'https://chat.example.com:8443/',
      'http://chat.example.com/',
      'https://games.chat.example.com/',
      'https://CHAT.example.com/',
    ]) {
      expect(externalUiOrigin(url, APP), url).toBeNull();
    }
    // The app on a subdomain of the site's host: the site could set cookies for it.
    expect(externalUiOrigin('https://example.com/', APP)).toBeNull();
    // Any of several app origins counts.
    expect(externalUiOrigin('http://localhost:3000/x', ['https://chat.example.com', 'http://localhost:19598'])).toBeNull();
  });

  it('refuses what is not a plain http(s) URL', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not a url', 'https://user:pw@game.example.net/', 'file:///etc/passwd']) {
      expect(externalUiOrigin(url, APP), url).toBeNull();
    }
  });

  it('tells local test hosts apart: localhost and 127.0.0.1 are different hosts', () => {
    expect(externalUiOrigin('http://127.0.0.1:19599/play', ['http://localhost:19598'])).toBe('http://127.0.0.1:19599');
    expect(externalUiOrigin('http://localhost:19599/play', ['http://localhost:19598'])).toBeNull();
  });
});

describe('appOrigins / configuredAppOrigins', () => {
  it('keeps the http(s) origins, once each', () => {
    expect(appOrigins(['https://chat.example.com/some/path', null, undefined, 'null', 'https://chat.example.com', 'ftp://x'])).toEqual([
      'https://chat.example.com',
    ]);
    expect(configuredAppOrigins({ LOBBYFORGE_APP_ORIGIN: 'https://a.example', NEXT_PUBLIC_BASE_URL: 'http://localhost:19520' })).toEqual([
      'https://a.example',
      'http://localhost:19520',
    ]);
    expect(configuredAppOrigins({})).toEqual([]);
  });
});

describe('isCspOrigin / sandbox flags / files path', () => {
  it('accepts only scheme://host[:port]', () => {
    expect(isCspOrigin('https://api.example.com')).toBe(true);
    expect(isCspOrigin('http://127.0.0.1:19599')).toBe(true);
    for (const bad of ['https://a;sandbox', "https://a' 'unsafe-eval", 'https://a.example.com/', 'https://a b', '*', 'https://*.example.com', 'wss://a.example.com']) {
      expect(isCspOrigin(bad), bad).toBe(false);
    }
  });

  it('never lets a frame navigate the lobby, open windows or show dialogs', () => {
    expect(FILES_FRAME_SANDBOX).toBe('allow-scripts');
    expect(EXTERNAL_FRAME_SANDBOX.split(' ').sort()).toEqual(['allow-forms', 'allow-pointer-lock', 'allow-same-origin', 'allow-scripts']);
    expect(EXTERNAL_FRAME_SANDBOX).not.toMatch(/top-navigation|popups|modals|downloads/);
  });

  it('builds the files path from encoded segments', () => {
    expect(pluginFrameSrc('sandbox-buzzer', '1.2.3')).toBe('/api/plugin-ui/sandbox-buzzer/1.2.3/index.html');
    expect(pluginFrameSrc('a/b', '1.0.0+x/y')).toBe('/api/plugin-ui/a%2Fb/1.0.0%2Bx%2Fy/index.html');
  });
});
