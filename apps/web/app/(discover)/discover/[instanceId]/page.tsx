import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getRegistryInstanceByInstanceId, HEARTBEAT_STALE_MS } from '@lobbyforge/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /discover/[instanceId] — instance detail. People see who a community is
 * BEFORE being sent to an unknown domain: identity, live stats, policies
 * and trust signals (verified, heartbeat freshness, version). The exit
 * goes through /discover/go (the external-redirect interceptor), never a
 * bare external link.
 *
 * English-only for this increment (i18n keys to follow — the grid above
 * is already translated).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<Metadata> {
  const { instanceId } = await params;
  return { title: `Community ${instanceId} — LobbyForge` };
}

function heartbeatLabel(at: Date | null): { text: string; live: boolean } {
  if (!at) return { text: 'No heartbeat yet', live: false };
  const ageMs = Date.now() - new Date(at).getTime();
  if (ageMs < 0) return { text: 'Just now', live: true };
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return { text: 'Live', live: true };
  if (minutes < 60) return { text: `${minutes} min ago`, live: minutes * 60_000 < HEARTBEAT_STALE_MS };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `${hours} h ago`, live: false };
  const days = Math.floor(hours / 24);
  return { text: `${days} d ago`, live: false };
}

export default async function InstanceDetailPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  if (!isOfficialDeployment()) redirect('/lobby');
  const { instanceId } = await params;

  let instance: Awaited<ReturnType<typeof getRegistryInstanceByInstanceId>> = null;
  try {
    instance = await getRegistryInstanceByInstanceId(getDb(), instanceId);
  } catch {
    // fall through to not-found
  }
  if (!instance || !instance.isListed || instance.isBlocked) notFound();

  const heartbeat = heartbeatLabel(instance.lastHeartbeatAt ?? null);
  const go = `/discover/go?id=${encodeURIComponent(instance.instanceId)}`;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center gap-3">
          <Link
            href="/discover"
            className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
            aria-label="Back to the directory"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </Link>
          <span className="text-sm text-text-muted truncate">Community directory</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 flex flex-col gap-10">
        {/* Identity */}
        <div className="flex flex-col sm:flex-row sm:items-start gap-6">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-3xl shrink-0">
            {instance.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-grow">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <h1 className="font-display font-bold text-3xl tracking-tight text-text-primary">
                {instance.name}
              </h1>
              {instance.isVerified ? (
                <span className="flex items-center gap-1 text-primary text-sm" title="Domain verified">
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                  Verified
                </span>
              ) : (
                <span className="text-text-muted text-sm">Not verified</span>
              )}
            </div>
            <p className="font-mono text-sm text-text-muted mb-3">{instance.domain}</p>
            {instance.description ? (
              <p className="text-text-secondary text-pretty leading-relaxed">
                {instance.description}
              </p>
            ) : null}
          </div>
        </div>

        {/* CTAs — the exit ALWAYS goes through the interceptor */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Link
            href={go}
            className="bg-primary-container text-[#07101E] px-8 py-4 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all text-center"
          >
            Open in browser
          </Link>
          <a
            href={`lobbyforge://connect?host=${encodeURIComponent(instance.domain)}`}
            className="border border-border-strong text-text-secondary px-8 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all text-center"
          >
            Open in LobbyForge desktop
          </a>
        </div>
        <p className="text-sm text-text-muted -mt-4">
          You&apos;ll sign in on the community&apos;s own site — LobbyForge has no central account.
        </p>

        {/* Live stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat
            icon={
              <span className={`w-2 h-2 rounded-full ${heartbeat.live ? 'bg-ember' : 'bg-text-muted'}`} />
            }
            value={String(instance.onlineUsers ?? 0)}
            label="online now"
          />
          <Stat
            icon={<span className="material-symbols-outlined text-[16px]">forum</span>}
            value={String(instance.publicRoomsCount ?? 0)}
            label="public rooms"
          />
          <Stat
            icon={<span className="material-symbols-outlined text-[16px]">monitor_heart</span>}
            value={instance.doctorScore != null ? String(instance.doctorScore) : '—'}
            label="doctor score"
          />
          <Stat
            icon={<span className="material-symbols-outlined text-[16px]">schedule</span>}
            value={heartbeat.text}
            label="last heartbeat"
          />
        </div>

        {/* Facts */}
        <div className="flex flex-col gap-4 border-t border-border-subtle pt-8">
          {instance.region ? (
            <Fact icon="location_on" label="Region" value={instance.region} />
          ) : null}
          {(instance.languages as string[])?.length > 0 ? (
            <Fact icon="translate" label="Languages" value={(instance.languages as string[]).join(', ')} />
          ) : null}
          {(instance.tags as string[])?.length > 0 ? (
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-text-muted text-[18px] mt-0.5">sell</span>
              <div className="flex flex-wrap gap-1.5">
                {(instance.tags as string[]).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-surface-container px-2.5 py-0.5 text-xs text-text-secondary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {instance.version ? (
            <Fact icon="deployed_code" label="LobbyForge version" value={instance.version} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-text-muted text-xs">{icon} {label}</span>
      <span className="text-xl font-semibold text-text-primary">{value}</span>
    </div>
  );
}

function Fact({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="material-symbols-outlined text-text-muted text-[18px]">{icon}</span>
      <span className="text-xs text-text-muted w-32 shrink-0">{label}</span>
      <span className="text-sm text-text-secondary">{value}</span>
    </div>
  );
}
