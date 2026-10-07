'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getPlugin } from '@/lib/plugin-registry';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { activityRefusalMessage, parseActivityRefusal } from '@/lib/activity-refusal';
import type { ActivityHostState } from '@/lib/activity-host-view';
import { PluginSurface } from '../room/PluginSurface';
import { findOpenActivity, useActivitySession } from '../room/useActivitySession';
import { ConnectionState, useLobbyVoice } from './LobbyVoiceProvider';
import { PluginFrameSurface } from './PluginFrame';
import { buildPanelPlayers } from './panel-players';
import type { InstalledApp } from './page';

/** How often the picker looks for a session someone else started. */
const OPEN_ACTIVITY_POLL_MS = 4000;

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
 *  - a session running → a status rail (app, players) above the
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
  hushle: { spine: 'bg-ember', glyph: 'text-ember', icon: 'forum' },
  quiz: { spine: 'bg-primary', glyph: 'text-primary', icon: 'quiz' },
  'vampire-village': { spine: 'bg-danger', glyph: 'text-danger', icon: 'dark_mode' },
  'watch-party': { spine: 'bg-success', glyph: 'text-success', icon: 'smart_display' },
  poll: { spine: 'bg-secondary', glyph: 'text-secondary', icon: 'ballot' },
  'dice-bot': { spine: 'bg-tertiary', glyph: 'text-tertiary', icon: 'casino' },
};
const DEFAULT_ACCENT = { spine: 'bg-secondary-container', glyph: 'text-text-secondary', icon: 'stadia_controller' };

const TRUST_KEYS: Record<string, string> = {
  official: 'lobbyMain.activities.trustOfficial',
  'verified-community': 'lobbyMain.activities.trustVerified',
  unverified: 'lobbyMain.activities.trustUnverified',
};

/** A trust level we ship a word for; anything else shows its raw value. */
function trustLabel(t: Translator, trustLevel: string): string {
  const key = TRUST_KEYS[trustLevel];
  return key ? t(key) : trustLevel;
}

/** "4–12 players", or null when the app declares no range. */
function playerRange(t: Translator, app: InstalledApp): string | null {
  if (app.minPlayers == null && app.maxPlayers == null) return null;
  return t('lobbyMain.activities.playerRange', {
    min: app.minPlayers ?? 1,
    max: app.maxPlayers ?? t('lobbyMain.activities.playerRangeAny'),
  });
}

function accentFor(pluginId: string) {
  return APP_ACCENTS[pluginId] ?? DEFAULT_ACCENT;
}

/** `team_setup` → `Team setup`. Phases are plugin-defined snake_case. */
export function LobbyActivityView({
  serverId,
  channelId,
  channelName,
  apps,
  currentUserId,
  canManageServer,
  canStartActivities = false,
}: {
  serverId: string;
  channelId: string;
  channelName: string;
  apps: InstalledApp[];
  currentUserId: string | null;
  canManageServer: boolean;
  /**
   * START_ACTIVITY: the end route lets this member end any session, not
   * only their own. A hint for showing End — the route decides.
   */
  canStartActivities?: boolean;
}) {
  const t = useT();
  const voice = useLobbyVoice();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  // A refused start, said in the reader's language. `existingSessionId`
  // is set when the channel already has an activity: the notice offers
  // to open it rather than dropping the player into a game they did not pick.
  const [launchError, setLaunchError] = useState<{
    text: string;
    offerOpen: boolean;
    existingSessionId: string | null;
  } | null>(null);
  // Word packs for plugins that pick a deck when a game starts (Hushle).
  // Fetched only while the session is still in its lobby phase, so a
  // game already under way doesn't re-request a deck nobody will choose.
  const [cardPacks, setCardPacks] = useState<CardPack[]>([]);

  const handleEnded = useCallback(() => {
    setSessionId(null);
    setResolving(false);
  }, []);

  const { detail, error, busy, setError, dispatch, end } = useActivitySession({
    serverId,
    sessionId,
    onEnded: handleEnded,
  });

  // Everyone the panel may need to name: the session's roster (people who
  // have acted), plus whoever is in this voice channel — their LiveKit
  // identity is their user id — so a host can seat players by name before
  // they have pressed anything.
  const roster = detail?.players;
  const voiceParticipants = voice.activeChannelId === channelId ? voice.participants : null;
  const panelPlayers = useMemo(
    () => buildPanelPlayers(roster ?? [], voiceParticipants ?? []),
    [roster, voiceParticipants]
  );

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

  // Someone else may start a game while this hub sits on the picker: look
  // again every few seconds until a session exists, so every viewer lands
  // in it without closing and reopening the hub.
  useEffect(() => {
    if (sessionId || resolving) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void findOpenActivity(serverId, channelId).then((open) => {
        if (!cancelled && open) setSessionId(open.id);
      });
    }, OPEN_ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, resolving, serverId, channelId]);

  const launch = useCallback(
    async (pluginId: string) => {
      setLaunching(pluginId);
      setLaunchError(null);
      setError(null);
      try {
        const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/activities`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId }),
        });
        if (!res.ok) {
          const refusal = parseActivityRefusal(res.status, await res.json().catch(() => ({})));
          // An older server answers the conflict with `{ activity }` and no
          // code: someone launched between render and click — join theirs.
          if (res.status === 409 && !refusal.code && refusal.sessionId) {
            setSessionId(refusal.sessionId);
            return;
          }
          const message = activityRefusalMessage(refusal, 'start');
          const exists = refusal.code === 'activity_exists';
          setLaunchError({
            text: t(message.key, message.params),
            offerOpen: exists,
            existingSessionId: exists ? refusal.sessionId : null,
          });
          return;
        }
        const data = (await res.json()) as { activity: { id: string } };
        setSessionId(data.activity.id);
      } catch {
        setLaunchError({ text: t('room.activity.error.network'), offerOpen: false, existingSessionId: null });
      } finally {
        setLaunching(null);
      }
    },
    [serverId, channelId, t, setError]
  );

  const openExisting = useCallback(
    async (existingSessionId: string | null) => {
      setLaunchError(null);
      if (existingSessionId) {
        setSessionId(existingSessionId);
        return;
      }
      const open = await findOpenActivity(serverId, channelId);
      if (open) setSessionId(open.id);
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

  // Who may end the session, as the end route decides it: the host, anyone
  // with START_ACTIVITY, and — once the host has abandoned a game played
  // over voice — anyone in its voice room.
  const isHost = Boolean(detail?.createdBy && currentUserId === detail.createdBy);
  const inVoiceRoom = voice.activeChannelId === channelId && voice.connectionState === ConnectionState.Connected;
  const host = detail?.host ?? null;
  const canEnd = isHost || canStartActivities || Boolean(host?.abandoned && inVoiceRoom);
  const hostNote = hostNoteKey(host, { isHost, inVoiceRoom });

  const pluginClient = detail ? getPlugin(detail.pluginId) : null;
  const appName = useMemo(() => {
    if (!detail) return null;
    return apps.find((a) => a.id === detail.pluginId)?.name ?? detail.pluginId;
  }, [apps, detail]);

  return (
    <main className="flex-1 flex flex-col bg-background min-w-0 relative text-[14px] animate-fade-in-up">
      <header className="h-16 pl-16 pr-6 md:pl-6 flex items-center justify-between border-b border-border-subtle bg-surface-dim/80 backdrop-blur-md z-10 sticky top-0 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <span className="material-symbols-outlined text-[24px] text-text-secondary">stadia_controller</span>
          <h2 className="font-body-lg font-bold text-text-primary truncate">
            {t('lobbyMain.activities.title')}
          </h2>
          <div className="h-4 w-[1px] bg-border-subtle mx-1" />
          {/* One phrase, one key: Turkish puts the channel name first
              and the postposition after it, so "in" cannot be a span of
              its own with the name emphasised inside it. */}
          <p className="font-label-sm hidden md:block text-text-secondary truncate">
            {t('lobbyMain.activities.inChannel', { name: channelName })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => voice.setMainViewMode('chat')}
          title={t('lobbyMain.activities.backTitle')}
          aria-label={t('lobbyMain.activities.closeLabel')}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
          <span className="hidden sm:inline">{t('lobbyMain.activities.close')}</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {resolving ? (
          <p className="px-6 py-8 text-sm text-text-muted">{t('lobbyMain.activities.resolving')}</p>
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
                <span className="sr-only">{t('lobbyMain.activities.live')}</span>
              </span>
              <span className="flex items-center gap-1.5 font-label-xs text-[11px] text-text-secondary">
                <span className="material-symbols-outlined text-[14px]">group</span>
                {t('lobbyMain.activities.playerCount', { count: panelPlayers.length })}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {isHost ? (
                  <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-label-xs text-[11px] font-medium text-primary">
                    {t('lobbyMain.activities.host')}
                  </span>
                ) : null}
                {canEnd ? (
                  <button
                    type="button"
                    onClick={() => void end()}
                    disabled={busy}
                    title={t('lobbyMain.activities.endTitle')}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden>stop_circle</span>
                    {t('lobbyMain.activities.end')}
                  </button>
                ) : null}
              </div>
              {hostNote ? (
                <p
                  role="status"
                  data-testid="activity-host-note"
                  className="flex w-full items-start gap-1.5 font-label-xs text-[12px] text-text-secondary"
                >
                  <span className="material-symbols-outlined text-[16px] text-ember" aria-hidden>
                    person_off
                  </span>
                  {t(hostNote)}
                </p>
              ) : null}
            </div>

            <div className="px-6 py-6">
              {pluginClient ? (
                <PluginSurface
                  pluginId={detail.pluginId}
                  render={pluginClient.renderClient}
                  props={{
                    state: detail.state,
                    dispatch: (action: unknown) => void dispatch(action as Record<string, unknown>),
                    actorUserId: currentUserId ?? '',
                    hostUserId: detail.createdBy,
                    players: panelPlayers,
                    cardPacks,
                  }}
                  fallback={<NoPlayerSurface pluginId={detail.pluginId} />}
                />
              ) : (
                // A marketplace plugin: its own UI, sandboxed (ADR-007), fed
                // the state the activity API projected for this viewer and
                // dispatching through the same session hook as the panels.
                <PluginFrameSurface
                  key={detail.pluginId}
                  pluginId={detail.pluginId}
                  appName={appName ?? detail.pluginId}
                  state={detail.state}
                  viewerId={currentUserId ?? ''}
                  hostUserId={detail.createdBy}
                  players={panelPlayers}
                  dispatch={dispatch}
                  fallback={<NoPlayerSurface pluginId={detail.pluginId} />}
                />
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
              <h1 className="font-section-h2-mobile text-text-primary">
                {t('lobbyMain.activities.heading')}
              </h1>
              <p className="mt-1 max-w-xl font-body-md text-text-secondary">
                {t('lobbyMain.activities.intro', { name: channelName })}
              </p>
            </div>

            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-subtle bg-surface/40 px-6 py-12 text-center">
                <span className="material-symbols-outlined text-[40px] text-text-muted" aria-hidden>
                  extension_off
                </span>
                <h2 className="mt-3 font-body-lg font-semibold text-text-primary">
                  {t('lobbyMain.activities.emptyTitle')}
                </h2>
                <p className="mx-auto mt-1 max-w-sm font-body-md text-text-secondary">
                  {canManageServer
                    ? t('lobbyMain.activities.emptyManage')
                    : t('lobbyMain.activities.emptyMember')}
                </p>
                {canManageServer ? (
                  <Link
                    href="/admin/apps"
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    {t('lobbyMain.activities.install')}
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
                            {app.sandboxed ? (
                              <MarketplaceBadge />
                            ) : app.trustLevel ? (
                              <span className="rounded border border-border-subtle px-1.5 py-0.5">
                                {trustLabel(t, app.trustLevel)}
                              </span>
                            ) : null}
                            {playerRange(t, app) ? <span>{playerRange(t, app)}</span> : null}
                          </span>
                          <span className="mt-auto flex items-center gap-2 pt-2 font-label-xs text-[11px] text-primary">
                            <span className="material-symbols-outlined text-[16px]">
                              {isLaunching ? 'progress_activity' : 'play_arrow'}
                            </span>
                            {isLaunching
                              ? t('lobbyMain.activities.starting')
                              : t('lobbyMain.activities.start')}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {launchError ? (
              <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-danger">
                <p>{launchError.text}</p>
                {launchError.offerOpen ? (
                  <button
                    type="button"
                    onClick={() => void openExisting(launchError.existingSessionId)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 font-medium text-text-primary transition-colors hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden>play_arrow</span>
                    {t('lobbyMain.activities.openExisting')}
                  </button>
                ) : null}
              </div>
            ) : error ? (
              // Left over from the session that just closed (e.g. "This
              // activity has ended."): the last thing the panel had to say.
              <p role="status" className="mt-4 text-xs text-text-secondary">
                {error}
              </p>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

/**
 * What to tell the room when the host of a game played over voice has
 * left it, or null. The host themselves sees nothing: the notes are about
 * who takes over and who may end the game.
 */
export function hostNoteKey(
  host: ActivityHostState | null,
  viewer: { isHost: boolean; inVoiceRoom: boolean }
): string | null {
  if (!host || host.inVoice || viewer.isHost) return null;
  if (host.abandoned) return viewer.inVoiceRoom ? 'lobbyMain.activities.hostLeft' : 'lobbyMain.activities.hostLeftJoin';
  if (host.transferAt) return 'lobbyMain.activities.hostAwayTransfer';
  if (host.abandonAt) return 'lobbyMain.activities.hostAwayWaiting';
  return null;
}

/**
 * The badge of an app installed from the marketplace. Official apps say
 * "Official"; a sandboxed one used to say nothing at all, which read as
 * the same trust. The hint is in the title for pointers and in the
 * accessible description for everyone else.
 */
function MarketplaceBadge() {
  const t = useT();
  const hint = t('lobbyMain.activities.trustMarketplaceHint');
  return (
    <span
      data-testid="marketplace-badge"
      title={hint}
      className="inline-flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5"
    >
      <span className="material-symbols-outlined text-[12px]" aria-hidden>
        storefront
      </span>
      {t('lobbyMain.activities.trustMarketplace')}
      {/* The card is one button: its text is what a screen reader says. */}
      <span className="sr-only"> {hint}</span>
    </span>
  );
}

/**
 * Shown when a plugin ships no player-facing UI. The raw state dump and
 * free-form action box that the voice room falls back to are a developer
 * tool; players get an honest message instead.
 */
function NoPlayerSurface({ pluginId }: { pluginId: string }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-dashed border-border-subtle bg-surface/40 px-6 py-10 text-center">
      <span className="material-symbols-outlined text-[32px] text-text-muted" aria-hidden>
        construction
      </span>
      <h2 className="mt-3 font-body-lg font-semibold text-text-primary">
        {t('lobbyMain.activities.noSurfaceTitle')}
      </h2>
      <p className="mx-auto mt-1 max-w-sm font-body-md text-text-secondary">
        {t('lobbyMain.activities.noSurfaceBody', { name: pluginId })}
      </p>
    </div>
  );
}
