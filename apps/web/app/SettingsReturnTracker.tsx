'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { SETTINGS_RETURN_KEY, isReturnPoint } from '@/lib/settings-return';

/**
 * Remembers, per tab, the last page a visitor could come back to — so the
 * settings modal can return there when it closes on the official hub (see
 * `lib/settings-return.ts`). The query string counts: `/lobby?server=…` is
 * a different community than `/lobby`.
 *
 * Renders nothing. Mounted once by the root layout, inside a Suspense
 * boundary because it reads the search params.
 */
export default function SettingsReturnTracker() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';

  useEffect(() => {
    if (!pathname || !isReturnPoint(pathname)) return;
    try {
      window.sessionStorage.setItem(SETTINGS_RETURN_KEY, search ? `${pathname}?${search}` : pathname);
    } catch {
      // Storage blocked or unavailable: closing settings falls back to the hub home.
    }
  }, [pathname, search]);

  return null;
}
