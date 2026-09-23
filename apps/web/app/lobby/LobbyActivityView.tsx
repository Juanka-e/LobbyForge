'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getPlugin } from '@/lib/plugin-registry';
import { PluginSurface } from '../room/PluginSurface';
import { findOpenActivity, useActivitySession } from '../room/useActivitySession';
import { useLobbyVoice } from './LobbyVoiceProvider';
import type { InstalledApp } from './page';

/**
 * The activities surface, in the centre column.
 *
 * design pass: starting a game used to mean leaving the lobby for
 * /room/<id>, a developer-facing page whose activity panel was a raw
 * JSON dump and a free-form action box on a hard-coded near-black
 * rectangle. Players got a debug console where they expected a game.
 *
 * Two states, one grammar with the rest of the app:
 *  - nothing running → a gallery of the community's installed apps,
 *    each a launch card with its accent spine, player range and trust.
 *  - a session running → a status rail (app, phase, players) above the
 *    plugin's own surface, which finally gets room to breathe.
 */

interface CardPack {
  id: string;
  slug: string;
  name: string;
  language: string;
  cardCount: number;
  isBuiltIn: boolean;
}

/** Per-app accent, so each game is recognisable at a glance in the gallery. */
const APP_ACCENTS: Record<string, { spine: string; glyph: string; icon: string }> = {
  hushle: { spine: 'bg-primary', glyph: 'text-primary', icon: 'forum' },
  quiz: { spine: 'bg-tertiary', glyph: 'text-tertiary', icon: 'quiz' },
  poll: { spine: 'bg-success', glyph: 'text-success', icon: 'ballot' },
  'dice-bot': { spine: 'bg-danger', glyph: 'text-danger', icon: 'casino' },
};
const DEFAULT_ACCENT = { spine: 'bg-secondary-container', glyph: 'text-text-secondary', icon: 'stadia_controller' };

const TRUST_LABELS: Record<string, string> = {
  official: 'Official',
  'verified-community': 'Verified',
  unverified: 'Unverified',
};

/** "4–12 players", or null when the app declares no range. */
function playerRange(app: InstalledApp): string | null {
  if (app.minPlayers == null && app.maxPlayers == null) return null;
  return `${app.minPlayers ?? 1}–${app.maxPlayers ?? 'any'} players`;
}

function accentFor(pluginId: string) {
  return APP_ACCENTS[pluginId] ?? DEFAULT_ACCENT;
}

/** `team_setup` → `Team setup`. Phases are plugin-defined snake_case. */
function humanisePhase(phase: unknown): string | null {
  if (typeof phase !== 'string' || !phase) return null;
  const spaced = phase.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function LobbyActivityView({
  serverId,
  channelId,
  channelName,
  apps,
  currentUserId,
  canManageServer,
}: {
  serverId: string;
  channelId: string;
  channelName: string;
  apps: InstalledApp[];
  currentUserId: string | null;
  canManageServer: boolean;
}) {
  const voice = useLobbyVoice();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  // Word packs for plugins that pick a deck when a game starts (Hushle).
  // Fetched only while the session is still in its lobby phase, so a
  // game already under way doesn't re-request a deck nobody will choose.
  const [cardPacks, setCardPacks] = useState<CardPack[]>([]);

  const handleEnded = useCallback(() => {
    setSessionId(null);
    setResolving(false);
  }, []);

  const { detail, error, busy, dispatch, end } = useActivitySession({
    serverId,
    sessionId,
    onEnded: handleEnded,
  });

  // Join whatever is already running in this channel, rather than
  // offering a launch that would answer 409.
  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    void (async () => {
      const open = await findOpenActivity(serverId, channelId);
      if (cancelled) return;
      setSessionId(open?.id ?? null);
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, channelId]);

  const launch = useCallback(
    async (pluginId: string) => {
      setLaunching(pluginId);
      setLaunchError(null);
      try {
        const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/activities`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId }),
        });
        if (res.status === 409) {
          // Someone else launched between render and click — join theirs.
          const conflict = (await res.json().catch(() => ({}))) as { activity?: { id: string } };
          if (conflict.activity?.id) {
            setSessionId(conflict.activity.id);
            return;
          }
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not start the activity (${res.status})`);
        }
        const data = (await res.json()) as { activity: { id: string } };
        setSessionId(data.activity.id);
      } catch (err) {
        setLaunchError((err as Error).message);
      } finally {
        setLaunching(null);
      }
    },
    [serverId, channelId]
  );

  const inLobbyPhase = (detail?.state as { phase?: unknown } | undefined)?.phase === 'lobby';
  useEffect(() => {
    if (!inLobbyPhase) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/card-packs`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { cardPacks?: CardPack[] };
        if (!cancelled) setCardPacks(data.cardPacks ?? []);
      } catch {
        // Soft failure — the plugin falls back to its language-only form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, inLobbyPhase]);

  const pluginClient = detail ? getPlugin(detail.pluginId) : null;
  const appName = useMemo(() => {
    if (!detail) return null;
    return apps.find((a) => a.id === detail.pluginId)?.name ?? detail.pluginId;
  }, [apps, detail]);
  const phase = humanisePhase((detail?.state as { phase?: unknown } | undefined)?.phase);

  return (
    <main className="flex-1 flex flex-col bg-background min-w-0 relative text-[14px] animate-fade-in-up">
      <header className="h-16 px-6 flex items-center justify-between border-b border-border-subtle bg-surface-dim/80 backdrop-blur-md z-10 sticky top-0 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <span className="material-symbols-outlined text-[24px] text-text-secondary">stadia_controller</span>
          <h2 className="font-body-lg font-bold text-text-primary truncate">Activities</h2>
          <div className="h-4 w-[1px] bg-border-subtle mx-1" />
          <p className="font-label-sm hidden md:block text-text-secondary truncate">
            in <span className="text-text-primary">{channelName}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => voice.setMainViewMode('chat')}
          title="Back to the channel"
          aria-label="Back to the channel"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
          <span className="hidden sm:inline">Close</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {resolving ? (
          <p className="px-6 py-8 text-sm text-text-muted">Checking for a game in progress…</p>
        ) : sessionId && detail ? (
          <section className="flex flex-col">
            {/* Status rail — what is running, where it is, who is in. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-subtle bg-surface-dim/40 px-6 py-3">
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full bg-success animate-pulse-soft"
                  aria-hidden
                />
                <span className={`material-symbols-outlined text-[20px] ${accentFor(detail.pluginId).glyph}`}>
                  {accentFor(detail.pluginId).icon}
                </span>
                <span className="font-label-sm font-semibold text-text-primary truncate">{appName}</span>
                <span className="sr-only">Live</span>
              </span>
              {phase ? (
                <span className="rounded-full border border-border-subtle bg-surface-container px-2.5 py-0.5 font-label-xs text-[11px] text-text-secondary">
                  {phase}
                </span>
              ) : null}
              <span className="flex items-center gap-1.5 font-label-xs text-[11px] text-text-secondary">
                <span className="material-symbols-outlined text-[14px]">group</span>
                {detail.players.length} {detail.players.length === 1 ? 'player' : 'players'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {detail.createdBy && currentUserId === detail.createdBy ? (
                  <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-label-xs text-[11px] font-medium text-primary">
                    You are the host
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void end()}
                  disabled={busy}
                  title="End this activity for everyone"
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[16px]">stop_circle</span>
                  End
                </button>
              </div>
            </div>

            <div className="px-6 py-6">
              {pluginClient ? (
                <PluginSurface
                  render={pluginClient.renderClient}
                  props={{
                    state: detail.state,
                    dispatch: (action: unknown) => void dispatch(action as Record<string, unknown>),
                    actorUserId: currentUserId ?? '',
                    hostUserId: detail.createdBy,
                    players: detail.players.map((p) => ({ userId: p.userId, name: p.name ?? null })),
                    cardPacks,
                  }}
                  fallback={<NoPlayerSurface pluginId={detail.pluginId} />}
                />
              ) : (
                <NoPlayerSurface pluginId={detail.pluginId} />
              )}
              {error ? (
                <p role="alert" className="mt-4 text-xs text-danger">
                  {error}
                </p>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="px-6 py-8">
            <div className="mb-6">
              <h1 className="font-section-h2-mobile text-text-primary">Start something together</h1>
              <p className="mt-1 max-w-xl font-body-md text-text-secondary">
                Everyone in <span className="text-text-primary">{channelName}</span> joins the same game.
                One activity runs per voice channel at a time.
              </p>
            </div>

            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-subtle bg-surface/40 px-6 py-12 text-center">
                <span className="material-symbols-outlined text-[40px] text-text-muted" aria-hidden>
                  extension_off
                </span>
                <h2 className="mt-3 font-body-lg font-semibold text-text-primary">No apps installed yet</h2>
                <p className="mx-auto mt-1 max-w-sm font-body-md text-text-secondary">
                  {canManageServer
                    ? 'Install a game or activity and it shows up here for every member.'
                    : 'Ask a server admin to install a game — it will show up here for everyone.'}
                </p>
                {canManageServer ? (
                  <Link
                    href="/admin/apps"
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    Install an app
                  </Link>
                ) : null}
              </div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {apps.map((app) => {
                  const accent = accentFor(app.id);
                  const isLaunching = launching === app.id;
                  return (
                    <li key={app.id}>
                      <button
                        type="button"
                        onClick={() => void launch(app.id)}
                        disabled={Boolean(launching)}
                        className="group relative flex h-full w-full overflow-hidden rounded-xl border border-border-subtle bg-surface text-left transition-all hover:border-border-strong hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {/* The spine is the recognisable mark: each app keeps
                            its colour across the gallery and the status rail. */}
                        <span className={`w-1 flex-shrink-0 ${accent.spine}`} aria-hidden />
                        <span className="flex flex-1 flex-col gap-2 p-4 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className={`material-symbols-outlined text-[22px] ${accent.glyph}`}>
                              {accent.icon}
                            </span>
                            <span className="font-body-lg font-semibold text-text-primary truncate">
                              {app.name}
                            </span>
                          </span>
                          {app.summary ? (
                            <span className="font-body-md text-text-secondary line-clamp-2">{app.summary}</span>
                          ) : null}
                          <span className="flex flex-wrap items-center gap-2 font-label-xs text-[11px] text-text-muted">
                            {app.trustLevel ? (
                              <span className="rounded border border-border-subtle px-1.5 py-0.5">
                                {TRUST_LABELS[app.trustLevel] ?? app.trustLevel}
                              </span>
                            ) : null}
                            {playerRange(app) ? <span>{playerRange(app)}</span> : null}
                          </span>
                          <span className="mt-auto flex items-center gap-2 pt-2 font-label-xs text-[11px] text-primary">
                            <span className="material-symbols-outlined text-[16px]">
                              {isLaunching ? 'progress_activity' : 'play_arrow'}
                            </span>
                            {isLaunching ? 'Starting…' : 'Start'}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {launchError ? (
              <p role="alert" className="mt-4 text-xs text-danger">
                {launchError}
              </p>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

/**
 * Shown when a plugin ships no player-facing UI. The raw state dump and
 * free-form action box that the voice room falls back to are a developer
 * tool; players get an honest message instead.
 */
function NoPlayerSurface({ pluginId }: { pluginId: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle bg-surface/40 px-6 py-10 text-center">
      <span className="material-symbols-outlined text-[32px] text-text-muted" aria-hidden>
        construction
      </span>
      <h2 className="mt-3 font-body-lg font-semibold text-text-primary">
        This app has no player screen yet
      </h2>
      <p className="mx-auto mt-1 max-w-sm font-body-md text-text-secondary">
        <span className="text-text-primary">{pluginId}</span> is running, but it doesn&apos;t provide a
        game view. Ending it frees the channel for another activity.
      </p>
    </div>
  );
}
