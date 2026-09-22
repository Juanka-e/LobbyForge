import Link from 'next/link';
import type { InstalledApp } from './page';

/**
 * Sidebar "Activities" section — the apps this community has installed.
 *
 * beta-review: installed apps were visible only through the admin panel
 * and the activity picker buried inside `/room/[roomName]`, so a regular
 * member had no way to see what the community could play, and an owner
 * who never found the install screen saw "No enabled apps for this
 * server" with no hint about what to do. Every member sees the list; the
 * empty state points admins at the install screen and tells members who
 * to ask.
 */
export function LobbyAppsSection({
  apps,
  voiceChannelId,
  serverId,
  canManageServer,
}: {
  apps: InstalledApp[];
  /** Where an activity would start — the first voice channel. */
  voiceChannelId: string | null;
  serverId: string | null;
  canManageServer: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-2">
        <h3 className="font-label-xs uppercase tracking-wider text-text-muted font-bold">
          Activities
        </h3>
        {canManageServer ? (
          <Link
            href="/admin/apps"
            title="Install or remove apps"
            aria-label="Install or remove apps"
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
          </Link>
        ) : null}
      </div>
      {apps.length === 0 ? (
        <p className="px-2 text-[11px] leading-relaxed text-text-muted">
          {canManageServer ? (
            <>
              No apps installed yet.{' '}
              <Link href="/admin/apps" className="text-primary hover:underline">
                Install one
              </Link>{' '}
              to start games in voice channels.
            </>
          ) : (
            'No apps installed yet — ask a server admin to add one.'
          )}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {apps.map((app) => (
            <li key={app.id}>
              {serverId && voiceChannelId ? (
                <a
                  href={`/room/${voiceChannelId}?serverId=${serverId}&channelId=${voiceChannelId}&app=${encodeURIComponent(app.id)}`}
                  title={app.summary ?? `Start ${app.name} in a voice channel`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors group"
                >
                  <span className="material-symbols-outlined text-[18px]">stadia_controller</span>
                  <span className="font-label-sm truncate">{app.name}</span>
                  <span className="material-symbols-outlined ml-auto text-[16px] opacity-0 group-hover:opacity-100 transition-opacity">
                    play_arrow
                  </span>
                </a>
              ) : (
                <span className="flex items-center gap-2 px-2 py-1.5 text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">stadia_controller</span>
                  <span className="font-label-sm truncate">{app.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
