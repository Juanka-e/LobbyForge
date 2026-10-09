import type { ReactNode } from 'react';
import { requireAdminArea } from '@/lib/admin-access';

/**
 * The admin area answers 404 to anyone who may open none of it — signed
 * out, guests, ordinary members — before anything renders. Which page a
 * viewer may open is each page's own guard (`requireAdminSection`), and
 * each page draws its own settings shell AFTER that guard: if this layout
 * drew the shell, a refused page would show its 404 inside the admin
 * chrome instead of looking like a page that does not exist. The `@modal`
 * interceptor renders the same pages without this layout, so the pages
 * have to carry their shell anyway.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminArea();
  return children;
}
