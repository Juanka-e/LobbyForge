import { notFound, redirect } from 'next/navigation';
import { requireAdminArea } from '@/lib/admin-access';

/**
 * The canonical route behind `app/@modal/(.)admin/[[...slug]]`: every URL
 * the interceptor can catch has to exist as a real page too, or a hard
 * load of it 404s while a click from the lobby works (Next 16.4 refuses to
 * build without one). The admin pages themselves are explicit routes and
 * win over this catch-all; what is left is `/admin` itself — the admin
 * overview — and URLs that are no page at all.
 */
export default async function AdminFallback({ params }: { params: Promise<{ slug?: string[] }> }) {
  // The layout guards too; a 404 for anyone who may open no admin page at all.
  await requireAdminArea();
  if (!(await params).slug?.length) redirect('/admin/settings');
  notFound();
}
