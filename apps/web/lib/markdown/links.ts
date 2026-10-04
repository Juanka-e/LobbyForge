/**
 * Where a link in a rendered repository document may point.
 *
 * Documents are written for GitHub, so their links are relative to the
 * file (`BOTS.md#errors`, `./ACTIVITIES.md`, `../packages/bot-sdk`). On the
 * site, a link to a document that has its own page goes to that page; a
 * link to any other repository file goes to the file on GitHub; a link
 * that would climb out of the repository is dropped.
 *
 * Only `http:`, `https:` and `mailto:` survive as absolute links. Anything
 * else with a scheme — `javascript:`, `data:`, `vbscript:`, `file:` … —
 * is dropped, and so are protocol-relative `//host` links. A dropped link
 * renders as its text.
 */

export interface ResolvedLink {
  href: string;
  /** Leaves the site (GitHub, an external page, a mail client). */
  external: boolean;
}

export interface DocLinkContext {
  /** The document the link appears in, relative to the repo root (`docs/BOTS.md`). */
  sourcePath: string;
  /** Repo-relative paths of documents that have a page here → that page's path. */
  pages: Readonly<Record<string, string>>;
  /** The repository on GitHub, e.g. `https://github.com/owner/name`. */
  repoUrl: string;
  /** The branch GitHub links point at. */
  branch?: string;
}

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Browsers drop ASCII control characters and spaces around a URL and
 * remove tabs and newlines inside it before they read the scheme
 * (`java\nscript:` is `javascript:`). Do the same before deciding.
 */
function clean(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/** `a/b/../c` → `a/c`; `null` when the path climbs above the repo root. */
function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveDocLink(raw: string, context: DocLinkContext): ResolvedLink | null {
  const href = clean(raw);
  if (href === '') return null;
  if (href.startsWith('#')) return href.length > 1 ? { href, external: false } : null;
  // `//evil.example` and `\\evil.example` are another host, not a path.
  if (/^[\\/]{2}/.test(href) || href.startsWith('/\\')) return null;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!ALLOWED_SCHEMES.has(scheme)) return null;
    try {
      const url = new URL(href);
      if (scheme !== 'mailto' && url.hostname === '') return null;
      return { href: url.href, external: true };
    } catch {
      return null;
    }
  }

  // A path in the repository: split off ?query and #fragment first.
  const hashAt = href.indexOf('#');
  const fragment = hashAt >= 0 ? href.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = beforeHash.indexOf('?');
  const query = queryAt >= 0 ? beforeHash.slice(queryAt) : '';
  const rawPath = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const path = safeDecode(rawPath).replace(/\\/g, '/');

  const sourceDir = context.sourcePath.includes('/')
    ? context.sourcePath.slice(0, context.sourcePath.lastIndexOf('/'))
    : '';
  // GitHub reads `/x` in a document as the repository root, not the site's.
  const target = normalizePath(path.startsWith('/') ? path : `${sourceDir}/${path}`);
  if (target === null) return null;

  const page = context.pages[target];
  if (page !== undefined) return { href: `${page}${fragment}`, external: false };

  const repo = context.repoUrl.replace(/\/+$/, '');
  if (target === '') return { href: `${repo}${fragment}`, external: true };
  const encoded = target.split('/').map(encodeURIComponent).join('/');
  try {
    const url = new URL(`${repo}/blob/${context.branch ?? 'main'}/${encoded}${query}${fragment}`);
    // The path is appended to a fixed prefix, so the host cannot change —
    // checked anyway, because this is the one place a doc decides it.
    if (url.origin !== new URL(repo).origin) return null;
    return { href: url.href, external: true };
  } catch {
    return null;
  }
}
