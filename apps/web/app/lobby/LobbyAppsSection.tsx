'use client';

import Link from 'next/link';
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
 * beneath it as small chips, and a live badge when a game is running.
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

      <button
        type="button"
        onClick={openHub}
        disabled={!open}
        aria-current={active ? 'page' : undefined}
        title={
          open
            ? `Open activities in ${voiceChannelName}`
            : 'Activities need a voice channel'
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
          {apps.length > 0 ? 'Play together' : 'Activities'}
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
              No apps yet —{' '}
              <Link href="/admin/apps" className="text-primary hover:underline">
                install one
              </Link>
              .
            </>
          ) : (
            'No apps yet — ask a server admin.'
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
                title={app.summary ?? `Start ${app.name}`}
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
