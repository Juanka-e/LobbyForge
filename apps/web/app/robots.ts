import type { MetadataRoute } from 'next';
import { getEffectiveInstanceAccessSettings } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * robots.txt — privacy-first.
 *
 * When seoIndexingEnabled is false (the default), ALL routes are blocked.
 * When enabled, only public-facing pages are allowed; private surfaces
 * (lobby, DM, admin, settings, API) are ALWAYS disallowed regardless of
 * the SEO toggle — they contain user data and must never be indexed.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await getEffectiveInstanceAccessSettings(getDb()).catch(() => null);
  const allowIndexing = settings?.seoIndexingEnabled === true;

  // Private routes that are ALWAYS disallowed — no exception.
  const privateRules = {
    userAgent: '*',
    disallow: [
      '/lobby',
      '/dm',
      '/admin',
      '/settings',
      '/room',
      '/servers',
      '/connect',
      '/api/',
      '/discover/go', // redirect interceptor — never index
    ],
  };

  if (!allowIndexing) {
    // SEO off → block everything.
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
      sitemap: undefined,
    };
  }

  // SEO on → allow public pages, block private ones.
  return {
    rules: [privateRules],
    sitemap: undefined,
  };
}
