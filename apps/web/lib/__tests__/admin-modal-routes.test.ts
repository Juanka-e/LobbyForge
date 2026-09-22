import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * beta-review regression guard.
 *
 * `app/@modal/(.)admin/[[...slug]]/page.tsx` and its `settings` sibling
 * intercept admin / user-settings routes so they open as an overlay over
 * the lobby. Both resolve the target through a hand-written map and call
 * `notFound()` on a miss — so a page that exists, renders fine on a hard
 * load and is linked from the settings nav still shows
 * "404 This page could not be found." when a user clicks it.
 *
 * That shipped: `/admin/plugins` and `/admin/moderation` were both
 * missing from the map. These tests walk the real route folders and fail
 * when a page is not represented in the interceptor.
 */

const APP_DIR = join(__dirname, '..', '..', 'app');

/** Route keys under `dir`, as the interceptor's slug join produces them. */
function routeKeys(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // Route groups `(x)` and parallel slots `@x` don't appear in the URL.
    if (entry.startsWith('(') || entry.startsWith('@')) {
      out.push(...routeKeys(full, prefix));
      continue;
    }
    const key = prefix ? `${prefix}/${entry}` : entry;
    if (readdirSync(full).includes('page.tsx')) out.push(key);
    out.push(...routeKeys(full, key));
  }
  return out;
}

/** A dynamic segment like `[runId]` — matched by prefix, not by key. */
function isDynamic(key: string): boolean {
  return key.includes('[');
}

describe('admin routes are reachable through the @modal interceptor', () => {
  const source = readFileSync(
    join(APP_DIR, '@modal', '(.)admin', '[[...slug]]', 'page.tsx'),
    'utf8'
  );
  const keys = routeKeys(join(APP_DIR, 'admin'));

  it('finds the admin routes on disk', () => {
    expect(keys).toContain('settings');
    expect(keys).toContain('plugins');
    expect(keys).toContain('moderation');
    expect(keys).toContain('apps');
  });

  it.each(keys.filter((key) => !isDynamic(key)))(
    'registers /admin/%s so clicking it does not 404',
    (key) => {
      // Keys with a slash or a dash are quoted in the map literal.
      const quoted = `'${key}':`;
      const bare = `${key}:`;
      expect(source.includes(quoted) || source.includes(bare)).toBe(true);
    }
  );

  it.each(keys.filter(isDynamic))('handles the dynamic route /admin/%s', (key) => {
    // The parent segment must be prefix-matched (e.g. `updates/`).
    const parent = key.slice(0, key.indexOf('[')).replace(/\/$/, '');
    expect(source).toContain(`'${parent}/'`);
  });
});

describe('user settings routes are reachable through the @modal interceptor', () => {
  const source = readFileSync(
    join(APP_DIR, '@modal', '(.)settings', '[[...slug]]', 'page.tsx'),
    'utf8'
  );
  const keys = routeKeys(join(APP_DIR, 'settings'));

  it.each(keys.filter((key) => !isDynamic(key)))(
    'registers /settings/%s so clicking it does not 404',
    (key) => {
      expect(source.includes(`'${key}':`) || source.includes(`${key}:`)).toBe(true);
    }
  );
});
