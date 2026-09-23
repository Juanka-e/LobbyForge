import { cookies, headers } from 'next/headers';
import { createTranslator, type Translator } from './messages';
import { negotiateLocale, readLocaleCookie } from './locale-cookie';
import type { AppLocale } from '@/lib/app-locale';

/**
 * The language for THIS request, for server components.
 *
 * The saved preference wins; a first-time visitor is negotiated from
 * `Accept-Language` so the first render is already in their language
 * rather than flashing English and correcting on hydration.
 */
export async function getRequestLocale(): Promise<AppLocale> {
  const store = await cookies();
  const saved = readLocaleCookie(store.toString());
  if (saved) return saved;
  const headerList = await headers();
  return negotiateLocale(headerList.get('accept-language'));
}

/** A translator bound to this request's language. */
export async function getTranslator(): Promise<Translator> {
  return createTranslator(await getRequestLocale());
}
