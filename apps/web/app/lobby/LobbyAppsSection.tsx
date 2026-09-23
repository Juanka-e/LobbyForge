'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n/client';
import { useLobbyVoice } from './LobbyVoiceProvider';
import type { InstalledApp } from './page';

/**
 * The community's activities, in the sidebar.
 *
 * design pass: this listed apps as flat text rows with a hover-only
 * play glyph and linked out to /room, so it read as a second channel
 * list and leaving the lobby was the only way to use it. It is now a
 * single "Activities" entry in the same grammar as a channel row —
 * opening the hub in the centre column — with the installed apps shown
 * beneath it as small chips.
 */
export function LobbyAppsSection({
  apps,
  voiceChannelId,
  voiceChannelName,
  serverId,
  canManageServer,
}: {
  apps: InstalledApp[];
  /** Where an activity would start — the active or first voice channel. */
  voiceChannelId: string | null;
  voiceChannelName: string;
  serverId: string | null;
  canManageServer: boolean;
}) {
  const t = useT();
  const voice = useLobbyVoice();
  const open = Boolean(serverId && voiceChannelId);
  const active =
    voice.mainViewMode === 'activity' &&
    voice.activeActivityChannel?.channelId === voiceChannelId;

  const openHub = () => {
    if (!voiceChannelId) return;
    voice.openActivities({ channelId: voiceChannelId, channelName: voiceChannelName });
  };

  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-2">
        <h3 className="font-label-xs uppercase tracking-wider text-text-muted font-bold">
          {t('lobby.apps.title')}
        </h3>
        {canManageServer ? (
          <Link
            href="/admin/apps"
            title={t('lobby.apps.manage')}
            aria-label={t('lobby.apps.manage')}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
          </Link>
        ) : null}
      </div>

      <button
        type="button"
        onClick={openHub}
        disabled={!open}
        aria-current={active ? 'page' : undefined}
        title={
          open
            ? t('lobby.apps.openIn', { channel: voiceChannelName })
            : t('lobby.apps.needsVoice')
        }
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          active
            ? 'bg-surface-container text-text-primary'
            : 'text-text-secondary hover:bg-surface-container hover:text-text-primary'
        } disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span
          className={`material-symbols-outlined text-[18px] ${active ? 'text-primary' : ''}`}
          style={active ? { fontVariationSettings: "'FILL' 1" } : undefined}
        >
          stadia_controller
        </span>
        <span className="font-label-sm truncate">
          {apps.length > 0 ? t('lobby.apps.playTogether') : t('lobby.apps.title')}
        </span>
        {apps.length > 0 ? (
          <span className="ml-auto rounded-full bg-surface-container-high px-1.5 py-0.5 font-label-xs text-[10px] text-text-muted">
            {apps.length}
          </span>
        ) : null}
      </button>

      {apps.length === 0 ? (
        <p className="mt-1 px-2 text-[11px] leading-relaxed text-text-muted">
          {canManageServer ? (
            <>
              {t('lobby.apps.emptyLead')}{' '}
              <Link href="/admin/apps" className="text-primary hover:underline">
                {t('lobby.apps.emptyInstallLink')}
              </Link>
              .
            </>
          ) : (
            t('lobby.apps.emptyMember')
          )}
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-wrap gap-1 px-2">
          {apps.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                onClick={openHub}
                disabled={!open}
                title={app.summary ?? t('lobby.apps.start', { name: app.name })}
                className="rounded-full border border-border-subtle px-2 py-0.5 font-label-xs text-[11px] text-text-secondary transition-colors hover:border-primary/40 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                {app.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
