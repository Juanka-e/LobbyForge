import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCatalogEntry, getRegistryInstanceByInstanceId } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /discover/go?id=<instanceId> — external-redirect interceptor.
 *
 * Shows a warning before navigating to a third-party LobbyForge instance.
 * The user's official-instance session/cookie does NOT cross over
 * (SameSite=Lax guarantees this). The destination creates its own guest
 * session if the visitor isn't already authenticated there.
 *
 * This page exists so that:
 * 1. The user explicitly confirms they're leaving the official host.
 * 2. Browsers show the target URL (no sneaky redirects).
 * 3. We can check isVerified + isBlocked server-side before linking.
 */
export default async function GoPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
  const id = params.id;
  if (!id) redirect('/discover');

  let instance: Awaited<ReturnType<typeof getRegistryInstanceByInstanceId>> | null = null;
  try {
    instance = await getRegistryInstanceByInstanceId(getDb(), id);
  } catch {
    // ignore — render not-found
  }

  if (!instance || !instance.isListed || instance.isBlocked) {
    return (
      <div className="min-h-dvh bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <span className="material-symbols-outlined text-5xl text-danger mb-3 block">block</span>
          <h1 className="text-xl font-semibold text-text-primary">Community not available</h1>
          <p className="mt-2 text-sm text-text-secondary">
            This community is no longer listed or has been removed from the directory.
          </p>
          <Link href="/discover" className="mt-4 inline-block text-sm text-primary hover:underline">
            ← Back to Discover
          </Link>
        </div>
      </div>
    );
  }

  const isVerified = instance.isVerified;

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="rounded-2xl border border-border-subtle bg-surface p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-secondary-container flex items-center justify-center font-bold text-text-primary text-lg">
              {instance.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-base font-semibold text-text-primary">{instance.name}</h1>
                {isVerified ? (
                  <span className="material-symbols-outlined text-[16px] text-primary" title="Verified by LobbyForge">
                    verified
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-text-muted">{instance.region ?? 'Unknown region'}</p>
            </div>
          </div>

          {/* Warning box */}
          <div className="rounded-lg border border-tertiary/30 bg-tertiary/5 p-3 mb-4">
            <p className="text-xs text-text-secondary leading-relaxed">
              You are about to leave <strong>LobbyForge</strong> and visit a
              community hosted by a third party at:
            </p>
            <p className="mt-2 text-sm font-mono text-text-primary bg-background rounded-md px-2 py-1 break-all border border-border-subtle">
              {instance.domain}
            </p>
            <ul className="mt-3 space-y-1 text-xs text-text-muted">
              <li className="flex items-start gap-1.5">
                <span className="material-symbols-outlined text-[12px] mt-0.5">check_circle</span>
                Your LobbyForge account stays here — it does not transfer.
              </li>
              <li className="flex items-start gap-1.5">
                <span className="material-symbols-outlined text-[12px] mt-0.5">check_circle</span>
                The destination will ask you to join or create a guest session.
              </li>
              {!isVerified ? (
                <li className="flex items-start gap-1.5">
                  <span className="material-symbols-outlined text-[12px] mt-0.5 text-tertiary">warning</span>
                  This community is <strong>not verified</strong> — proceed with caution.
                </li>
              ) : null}
              <li className="flex items-start gap-1.5">
                <span className="material-symbols-outlined text-[12px] mt-0.5">info</span>
                LobbyForge is not responsible for content on third-party servers.
              </li>
            </ul>
          </div>

          <div className="flex gap-3">
            <Link
              href="/discover"
              className="flex-1 rounded-lg border border-border-subtle bg-surface-raised px-4 py-2.5 text-sm font-medium text-text-secondary text-center hover:bg-surface-container transition-colors"
            >
              Cancel
            </Link>
            <a
              href={instance.domain}
              rel="noopener noreferrer"
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary text-center hover:brightness-110 transition-all"
            >
              Continue →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
