import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS, adminSectionForPath } from '@/lib/admin-sections';

/**
 * Every admin page is guarded on the server, before it renders anything.
 *
 * A page under `app/admin/**` that forgets the guard would render for
 * anyone who types its URL — the "permission required" screens this
 * replaced were exactly that: the admin chrome, drawn for everybody, with
 * a refusal inside. These tests walk the real route folders, so a new
 * page fails the build until it calls `requireAdminSection` for the
 * section its path belongs to (lib/admin-sections.ts), as the FIRST thing
 * it awaits, and guards its title the same way.
 */

const APP_DIR = join(__dirname, '..', '..', 'app');
const ADMIN_DIR = join(APP_DIR, 'admin');

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...pageFiles(full));
    } else if (entry === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

/** `app/admin/settings/members/page.tsx` → `/admin/settings/members`; `[runId]` → a sample id. */
function urlFor(file: string): string {
  const parts = relative(APP_DIR, file).split(sep).slice(0, -1);
  return `/${parts.map((part) => (part.startsWith('[') ? 'sample' : part)).join('/')}`;
}

/** The source of a function, from its declaration to its first `await`. */
function firstAwait(source: string, declaration: RegExp): string | null {
  const match = declaration.exec(source);
  if (!match) return null;
  const rest = source.slice(match.index);
  const at = rest.indexOf('await ');
  if (at < 0) return null;
  return rest.slice(at, rest.indexOf(';', at));
}

const pages = pageFiles(ADMIN_DIR).map((file) => ({
  file,
  url: urlFor(file),
  source: readFileSync(file, 'utf8'),
}));

describe('every admin page goes through the guard', () => {
  it('finds the admin pages on disk', () => {
    expect(pages.length).toBeGreaterThanOrEqual(ADMIN_SECTIONS.length);
    expect(pages.map((page) => page.url)).toContain('/admin/settings/members');
  });

  it('has a page for every section, and a section for every page', () => {
    const sections = new Set(pages.map((page) => adminSectionForPath(page.url)));
    for (const section of ADMIN_SECTIONS) expect(sections.has(section)).toBe(true);
    expect(sections.has(null)).toBe(false);
  });

  describe.each(pages.map((page) => [page.url, page] as const))('%s', (_url, page) => {
    const section = adminSectionForPath(page.url);

    it('is a server component', () => {
      expect(page.source).not.toMatch(/^\s*['"]use client['"]/m);
    });

    it(`awaits requireAdminSection('${section}') before anything else`, () => {
      expect(firstAwait(page.source, /export default async function \w+/)).toBe(
        `await requireAdminSection('${section}')`
      );
    });

    it('guards its title too', () => {
      const metadata = /export async function generateMetadata\(\)[^{]*\{([\s\S]*?)\n\}/.exec(page.source);
      expect(metadata, 'generateMetadata is missing').not.toBeNull();
      expect(metadata![1]).toMatch(new RegExp(`(adminPageMetadata|requireAdminSection)\\('${section}'`));
    });

    it('shows a nav of only the sections the viewer may open', () => {
      const shells = page.source.match(/<SettingsShell scope="community"[^>]*>/g) ?? [];
      expect(shells.length).toBeGreaterThan(0);
      for (const shell of shells) expect(shell).toContain('sections={access.sections}');
    });

    it('carries no "permission required" screen of its own', () => {
      expect(page.source).not.toContain('common.adminRequired');
      expect(page.source).not.toContain('isInstanceAdminAllowed');
    });
  });
});

describe('the admin area’s own guards', () => {
  it('the layout 404s anyone who may open no section, and draws no chrome of its own', () => {
    const layout = readFileSync(join(ADMIN_DIR, 'layout.tsx'), 'utf8');
    expect(firstAwait(layout, /export default async function \w+/)).toBe('await requireAdminArea()');
    expect(layout).not.toContain('<SettingsShell');
  });

  it('the @modal interceptor (which the layout does not wrap) guards too', () => {
    const intercept = readFileSync(join(APP_DIR, '@modal', '(.)admin', '[[...slug]]', 'page.tsx'), 'utf8');
    expect(firstAwait(intercept, /export default async function \w+/)).toBe('await requireAdminArea()');
  });

  it('a community’s settings page (/servers/{id}) is guarded on the server', () => {
    const source = readFileSync(join(APP_DIR, 'servers', '[id]', 'page.tsx'), 'utf8');
    expect(source).not.toMatch(/^\s*['"]use client['"]/m);
    const body = source.slice(source.indexOf('export default async function'));
    const guard = body.indexOf('await requireServerSettings(');
    expect(guard).toBeGreaterThan(-1);
    // Only the route params are read before it.
    expect(body.slice(0, guard).match(/await /g)).toEqual(['await ']);
    expect(body.slice(0, guard)).toContain('await params');
  });
});
