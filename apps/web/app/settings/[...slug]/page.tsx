import { notFound } from 'next/navigation';

/**
 * The canonical route behind `app/@modal/(.)settings/[[...slug]]` for URLs
 * that are no settings page: the interceptor may catch them, so they must
 * exist as real routes too (Next 16.4 refuses to build otherwise). The
 * settings pages are explicit routes and win over this catch-all.
 */
export default function SettingsFallback() {
  notFound();
}
