import type { MetadataRoute } from 'next';
import { getEffectiveInstanceAccessSettings } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await getEffectiveInstanceAccessSettings(getDb()).catch(() => null);
  const allowIndexing = settings?.seoIndexingEnabled === true;
  return {
    rules: allowIndexing
      ? { userAgent: '*', allow: '/' }
      : { userAgent: '*', disallow: '/' },
  };
}
