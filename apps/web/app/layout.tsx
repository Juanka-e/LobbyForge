import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Geist } from 'next/font/google';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { readMaintenanceSnapshot } from '@/lib/maintenance-guard';
import { getEffectiveInstanceAccessSettings } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import 'material-symbols/outlined.css';
import './globals.css';
import GlobalHeader from './GlobalHeader';
import AppearanceRuntime from './AppearanceRuntime';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getEffectiveInstanceAccessSettings(getDb()).catch(() => null);
  const indexing = settings?.seoIndexingEnabled ?? false;
  return {
    title: settings?.seoTitle || 'LobbyForge',
    description: settings?.seoDescription || 'Self-hostable voice-first community platform.',
    robots: { index: indexing, follow: indexing },
  };
}

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  const cookieStore = await cookies();
  const isAdmin = await isInstanceAdminAllowed(
    cookieStore.toString(),
    cookieStore.get(ADMIN_TOKEN_COOKIE)?.value
  );
  const maintenance = isAdmin ? null : await readMaintenanceSnapshot();
  const content = maintenance?.maintenanceMode ? (
    <section className="max-w-[720px]">
      <h1 className="mt-0">Maintenance</h1>
      <p className="text-text-secondary text-body-lg">
        {maintenance.maintenanceMessage ?? 'LobbyForge is temporarily in maintenance mode.'}
      </p>
      {maintenance.maintenanceStartedAt ? (
        <p className="text-text-muted">
          Started at {maintenance.maintenanceStartedAt.toISOString()}
        </p>
      ) : null}
    </section>
  ) : (
    children
  );

  return (
    <html lang="en" className={`${geist.variable} dark`}>
      <body className="bg-background text-text-primary font-body-md antialiased min-h-screen flex flex-col">
        <AppearanceRuntime />
        <GlobalHeader />
        <main className="flex-1">{content}</main>
        {maintenance?.maintenanceMode ? null : modal}
      </body>
    </html>
  );
}
