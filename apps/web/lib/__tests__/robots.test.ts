import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ value: null as { seoIndexingEnabled: boolean } | null }));

vi.mock('@lobbyforge/db', () => ({ getEffectiveInstanceAccessSettings: async () => settings.value }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

import robots from '@/app/robots';

type Rule = { userAgent?: string | string[]; disallow?: string | string[] };
const disallowed = (rules: Rule | Rule[]) =>
  (Array.isArray(rules) ? rules : [rules]).flatMap((rule) => (Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? '']));

/** Would a crawler that honours `disallow` prefixes skip this path? */
const blocks = (rules: Rule | Rule[], path: string) => disallowed(rules).some((prefix) => prefix !== '' && path.startsWith(prefix));

beforeEach(() => {
  settings.value = null;
});

describe('robots.txt and the Developers pages', () => {
  it('keeps every page, the docs included, out of search by default (self-host)', async () => {
    const { rules } = await robots();
    expect(blocks(rules as Rule[], '/developers')).toBe(true);
    expect(blocks(rules as Rule[], '/developers/bots')).toBe(true);
  });

  it('lets the docs be indexed once an instance turns SEO on — how the official hub publishes them', async () => {
    settings.value = { seoIndexingEnabled: true };
    const { rules } = await robots();
    for (const path of ['/developers', '/developers/bots', '/developers/bot-api-v2', '/developers/plugins']) {
      expect(blocks(rules as Rule[], path), path).toBe(false);
    }
    // Private surfaces stay blocked either way.
    expect(blocks(rules as Rule[], '/admin/settings/bots')).toBe(true);
    expect(blocks(rules as Rule[], '/lobby')).toBe(true);
  });
});
