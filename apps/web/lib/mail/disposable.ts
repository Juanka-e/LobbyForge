/**
 * Disposable email domains (docs/EMAIL.md §4.5). The list is the CC0
 * `disposable-email-domains` blocklist, vendored in
 * `disposable-domains.json` (refresh: `node scripts/update-disposable-domains.mjs`).
 *
 *   - a subdomain matches its listed parent (`x.mailinator.com`);
 *   - the admin's lists go on top, and ALLOW wins over block — an allowed
 *     domain (or a parent of it) is never refused, even when it is listed;
 *   - nothing else is normalised: plus addressing and Gmail dots are
 *     legitimate, and there is no MX lookup.
 *
 * Server-only (the list is ~180 KB; it must not reach a client bundle).
 */
import vendored from './disposable-domains.json';
import type { DisposableOverrides } from './types';

const LIST_KEY = '__lobbyforgeDisposableDomains__';

/** One Set per process (on globalThis: Next splits modules across chunks). */
function listedDomains(): ReadonlySet<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  let set = g[LIST_KEY];
  if (!set) {
    set = new Set((vendored as { domains: string[] }).domains);
    g[LIST_KEY] = set;
  }
  return set;
}

export const DISPOSABLE_LIST_INFO = Object.freeze({
  source: (vendored as { source: string }).source,
  commit: (vendored as { commit: string }).commit,
  fetchedAt: (vendored as { fetchedAt: string }).fetchedAt,
  count: (vendored as { count: number }).count,
});

/** The domain and every parent of it, most specific first: a.b.example.org → [a.b.example.org, b.example.org, example.org]. */
function domainChain(domain: string): string[] {
  const labels = domain.split('.');
  const chain: string[] = [];
  for (let i = 0; i < labels.length - 1; i += 1) chain.push(labels.slice(i).join('.'));
  return chain;
}

/** The domain part of an address, lower case; null when there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '') || null;
}

/** Is this address on a disposable domain, after the admin's allow and block lists? */
export function isDisposableEmail(email: string, overrides: DisposableOverrides = { allow: [], block: [] }): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const chain = domainChain(domain);
  if (chain.length === 0) return false;
  const allow = new Set(overrides.allow);
  if (chain.some((d) => allow.has(d))) return false;
  const block = new Set(overrides.block);
  const listed = listedDomains();
  return chain.some((d) => block.has(d) || listed.has(d));
}

/** A clean domain for the admin's lists, or null when the value is not one. */
export function normaliseDomainEntry(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value) ? value : null;
}
