/**
 * Dice Bot renderClient — the React panel the activity host mounts in a
 * voice room once a `dice-bot` activity is running.
 *
 * Presentational only. The panel receives the server-authoritative
 * `state` snapshot plus a `dispatch` that POSTs to the activity action
 * route; the host re-renders it with the next state when the round trip
 * completes.
 *
 * IMPORTANT: the panel NEVER generates a roll. `rollDie` lives in the
 * reducer (server-side projection), so a client can only ask for a roll
 * — `{ type: 'roll', playerId, sides }` — and render whatever comes
 * back. The die picker is limited to values the reducer accepts so the
 * server-side clamp is never the thing correcting the UI.
 *
 * Styling: plugin directories sit outside the web app's Tailwind
 * `content` globs, so utility classes would compile to nothing. Every
 * style is inline, and every colour reads a `--lf-*` host theme
 * variable with the dark-theme value as its fallback so the panel
 * follows the room's theme (and still renders standalone).
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  loadPluginLocale,
  tFor as tForShared,
  pickBestLocale,
  detectLocale,
} from '@lobbyforge/plugin-sdk';
import en from '../locales/en.json';
import tr from '../locales/tr.json';
import { DICE_MAX_SIDES, DICE_MIN_SIDES, DICE_PLUGIN_ID } from './constants';
import type { DiceAction, DiceRoll, DiceState } from './index';

// Register the plugin's locale tables with the shared SDK registry.
// Adding a language is a one-liner: drop `locales/<lang>.json` in and
// add it to this map.
loadPluginLocale(DICE_PLUGIN_ID, { en, tr });

export interface DicePanelPlayer {
  userId: string;
  name?: string | null;
}

export interface DicePanelClientProps {
  state: DiceState;
  dispatch: (action: DiceAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: DicePanelPlayer[];
  /**
   * The host passes the server's Hushle word packs to every plugin
   * panel. Dice Bot has no decks — accepted and ignored so the shared
   * prop bag type-checks.
   */
  cardPacks?: unknown;
}

export type DicePanelProps = DicePanelClientProps;

type Translate = (key: string, params?: Record<string, string | number>) => string;

const localeTables: Record<string, Record<string, string>> = { en, tr };

function tFor(locale: string, key: string, params?: Record<string, string | number>): string {
  // Delegate to the shared SDK helper so this file reads the same as a
  // community plugin would write it. `localeTables` is kept so a later
  // iteration can swap in a remote catalog without touching call sites.
  void localeTables;
  return tForShared(DICE_PLUGIN_ID, locale, key, params);
}

/**
 * The die sizes the picker offers. Every entry must survive the
 * reducer's clamp (`min(DICE_MAX_SIDES, max(DICE_MIN_SIDES, sides))`)
 * untouched, otherwise the UI would promise a die the server refuses to
 * roll. The filter makes that a compile-time-adjacent guarantee rather
 * than a comment.
 */
export const DICE_DIE_SIZES: readonly number[] = [2, 4, 6, 8, 10, 12, 20, 100].filter(
  (sides) => sides >= DICE_MIN_SIDES && sides <= DICE_MAX_SIDES
);

const DICE_DEFAULT_SIDES = 6;
/** How many history entries the panel shows before collapsing the rest. */
const DICE_VISIBLE_HISTORY = 8;

/* ---------------------------------------------------------------- styles */

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 640,
  // Without this the headings inherit the PAGE text colour and go
  // invisible against the card surface on the light theme.
  color: 'var(--lf-text-primary, #e6e8eb)',
};

const cardStyle: CSSProperties = {
  background: 'var(--lf-surface, #0e1218)',
  color: 'var(--lf-text-primary, #e6e8eb)',
  border: '1px solid var(--lf-border-subtle, #2a3140)',
  borderRadius: 8,
  padding: 16,
};

const mutedStyle: CSSProperties = {
  color: 'var(--lf-text-secondary, #9aa3ad)',
  fontSize: 13,
};

const baseButtonStyle: CSSProperties = {
  padding: '6px 12px',
  background: 'var(--lf-surface-container, #1c2530)',
  color: 'var(--lf-text-primary, #e6e8eb)',
  border: '1px solid var(--lf-border-subtle, #2a3140)',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#2f8f62',
  borderColor: '#246f4d',
  color: '#ffffff',
  fontSize: 15,
  fontWeight: 600,
  padding: '10px 18px',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#7a2a2a',
  borderColor: '#5a1f1f',
  color: '#ffffff',
};

const disabledStyle: CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };

const badgeBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};

// Semantic accents: literal hex, but each carries its own foreground so
// it stays legible on either host theme.
const enabledBadgeStyle: CSSProperties = {
  ...badgeBase,
  background: '#1d5e42',
  border: '1px solid #2f8f62',
  color: '#d7f5e6',
};

const pausedBadgeStyle: CSSProperties = {
  ...badgeBase,
  background: '#5c3a12',
  border: '1px solid #8a5a1d',
  color: '#ffe6c4',
};

const cellStyle: CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--lf-border-subtle, #2a3140)',
  fontSize: 13,
};

const headerCellStyle: CSSProperties = {
  ...cellStyle,
  color: 'var(--lf-text-secondary, #9aa3ad)',
  fontSize: 12,
  fontWeight: 600,
  textAlign: 'right',
};

/* --------------------------------------------------------------- helpers */

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function displayNameFor(players: DicePanelPlayer[], userId: string | null): string {
  if (!userId) return '—';
  const match = players.find((p) => p.userId === userId);
  const name = match?.name?.trim();
  return name && name.length > 0 ? name : userId.slice(0, 8);
}

function relativeTime(iso: string, now: number, t: Translate): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return t('dice.time.now');
  if (seconds < 60) return t('dice.time.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('dice.time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dice.time.hours', { count: hours });
  return t('dice.time.days', { count: Math.floor(hours / 24) });
}

/* ----------------------------------------------------------------- panel */

export function DicePanel(props: DicePanelProps): ReactNode {
  const { state, dispatch, actorUserId, hostUserId, players } = props;
  const isHost = hostUserId !== null && actorUserId === hostUserId;
  // Resolve against the locales the plugin actually registered so a
  // browser set to `fr` falls back to en/tr instead of showing raw keys.
  const locale = useMemo(
    () => pickBestLocale(DICE_PLUGIN_ID, detectLocale('en')),
    // Mount only — the document language does not change mid-session.
    []
  );
  const t: Translate = (key, params) => tFor(locale, key, params);
  const now = useNow(1000);

  const [sides, setSides] = useState<number>(DICE_DEFAULT_SIDES);
  const [pending, setPending] = useState(false);

  const canRoll = state.enabled && !pending && actorUserId.length > 0;

  const roll = () => {
    if (!canRoll) return;
    const result = dispatch({ type: 'roll', playerId: actorUserId, sides });
    // The host's dispatch is fire-and-forget (returns void); an async
    // one gets a busy state so a double tap cannot queue two rolls.
    if (result && typeof (result as Promise<void>).then === 'function') {
      setPending(true);
      (result as Promise<void>).then(
        () => setPending(false),
        () => setPending(false)
      );
    }
  };

  const visibleHistory = state.history.slice(0, DICE_VISIBLE_HISTORY);
  const hiddenHistory = Math.max(0, state.history.length - visibleHistory.length);

  const statRows = useMemo(
    () =>
      Object.entries(state.stats)
        .map(([userId, stats]) => ({ userId, ...stats }))
        .sort(
          (a, b) =>
            b.best - a.best ||
            b.sum - a.sum ||
            b.rolls - a.rolls ||
            a.userId.localeCompare(b.userId)
        ),
    [state.stats]
  );

  return (
    <div style={rootStyle}>
      <div style={cardStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 6,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('dice.title')}</h3>
          {state.enabled ? (
            <span style={enabledBadgeStyle}>{t('dice.status.enabled')}</span>
          ) : (
            <span style={pausedBadgeStyle}>{t('dice.status.disabled')}</span>
          )}
        </div>
        <p style={{ ...mutedStyle, margin: 0 }}>{t('dice.tagline')}</p>
        {state.enabled ? null : (
          <p
            style={{
              margin: '12px 0 0 0',
              padding: '8px 10px',
              borderRadius: 6,
              background: '#5c3a12',
              border: '1px solid #8a5a1d',
              color: '#ffe6c4',
              fontSize: 13,
            }}
          >
            {t('dice.paused.notice')}
          </p>
        )}
      </div>

      <LastRollHero
        lastRoll={state.lastRoll}
        players={players}
        now={now}
        t={t}
      />

      <div style={cardStyle}>
        <span style={{ ...mutedStyle, display: 'block', fontSize: 12, marginBottom: 6 }}>
          {t('dice.roll.dieLabel')}
        </span>
        <div
          role="group"
          aria-label={t('dice.roll.dieLabel')}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}
        >
          {DICE_DIE_SIZES.map((option) => {
            const selected = option === sides;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                aria-label={t('dice.roll.selectDie', { sides: option })}
                onClick={() => setSides(option)}
                style={{
                  ...baseButtonStyle,
                  minWidth: 46,
                  fontWeight: selected ? 700 : 400,
                  ...(selected
                    ? { background: '#2f8f62', borderColor: '#246f4d', color: '#ffffff' }
                    : {}),
                }}
              >
                d{option}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={roll}
          disabled={!canRoll}
          aria-label={pending ? undefined : t('dice.roll.buttonAria', { sides })}
          style={{ ...primaryButtonStyle, ...(canRoll ? {} : disabledStyle) }}
        >
          {pending ? t('dice.roll.busy') : t('dice.roll.button', { sides })}
        </button>
      </div>

      <div style={cardStyle}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: 13 }}>{t('dice.history.heading')}</h4>
        {visibleHistory.length === 0 ? (
          <p style={{ ...mutedStyle, margin: 0 }}>{t('dice.history.empty')}</p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {visibleHistory.map((entry, index) => (
                <li
                  key={`${entry.at}-${entry.playerId}-${index}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 4,
                    marginBottom: 4,
                    background: 'var(--lf-surface-raised, #11151b)',
                    fontSize: 13,
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayNameFor(players, entry.playerId)}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ ...mutedStyle, fontSize: 12 }}>d{entry.sides}</span>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{entry.value}</strong>
                    <time
                      dateTime={entry.at}
                      style={{ ...mutedStyle, fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {relativeTime(entry.at, now, t)}
                    </time>
                  </span>
                </li>
              ))}
            </ul>
            {hiddenHistory > 0 ? (
              <p style={{ ...mutedStyle, margin: '6px 0 0 0', fontSize: 12 }}>
                {t('dice.history.more', { count: hiddenHistory })}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div style={cardStyle}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: 13 }}>{t('dice.stats.heading')}</h4>
        {statRows.length === 0 ? (
          <p style={{ ...mutedStyle, margin: 0 }}>{t('dice.stats.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" style={{ ...headerCellStyle, textAlign: 'left' }}>
                  {t('dice.stats.player')}
                </th>
                <th scope="col" style={headerCellStyle}>
                  {t('dice.stats.rolls')}
                </th>
                <th scope="col" style={headerCellStyle}>
                  {t('dice.stats.sum')}
                </th>
                <th scope="col" style={headerCellStyle}>
                  {t('dice.stats.best')}
                </th>
              </tr>
            </thead>
            <tbody>
              {statRows.map((row, index) => (
                <tr key={row.userId}>
                  <th
                    scope="row"
                    style={{
                      ...cellStyle,
                      textAlign: 'left',
                      fontWeight: row.userId === actorUserId ? 700 : 400,
                    }}
                  >
                    {displayNameFor(players, row.userId)}
                    {row.userId === actorUserId ? (
                      <span style={{ ...mutedStyle, fontSize: 11 }}> ({t('dice.stats.you')})</span>
                    ) : null}
                    {index === 0 ? (
                      <span style={{ ...enabledBadgeStyle, fontSize: 11, marginLeft: 6 }}>
                        {t('dice.stats.leader')}
                      </span>
                    ) : null}
                  </th>
                  <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {row.rolls}
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {row.sum}
                  </td>
                  <td
                    style={{
                      ...cellStyle,
                      textAlign: 'right',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {row.best}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isHost ? (
        <div style={cardStyle}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: 13 }}>{t('dice.host.heading')}</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              onClick={() =>
                // `set-enabled`, not `toggle`: a flip computed from a
                // snapshot that has already moved sets the wrong value.
                void dispatch({ type: 'set-enabled', hostId: actorUserId, enabled: !state.enabled })
              }
              aria-label={
                state.enabled ? t('dice.host.disableAria') : t('dice.host.enableAria')
              }
              style={baseButtonStyle}
            >
              {state.enabled ? t('dice.host.disable') : t('dice.host.enable')}
            </button>
            <button
              type="button"
              onClick={() => void dispatch({ type: 'reset-stats', hostId: actorUserId })}
              aria-label={t('dice.host.resetAria')}
              style={dangerButtonStyle}
            >
              {t('dice.host.reset')}
            </button>
            <button
              type="button"
              onClick={() => void dispatch({ type: 'clear-history', hostId: actorUserId })}
              aria-label={t('dice.host.clearHistoryAria')}
              style={dangerButtonStyle}
            >
              {t('dice.host.clearHistory')}
            </button>
          </div>
          <p style={{ ...mutedStyle, margin: '8px 0 0 0', fontSize: 12 }}>
            {t('dice.host.resetHint')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LastRollHero({
  lastRoll,
  players,
  now,
  t,
}: {
  lastRoll: DiceRoll | null;
  players: DicePanelPlayer[];
  now: number;
  t: Translate;
}): ReactNode {
  return (
    <div
      style={{
        ...cardStyle,
        background: 'var(--lf-surface-raised, #11151b)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div
        aria-hidden
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 84,
          height: 84,
          borderRadius: 12,
          background: 'var(--lf-surface-container, #1c2530)',
          border: '1px solid var(--lf-border-subtle, #2a3140)',
          fontSize: lastRoll && lastRoll.value >= 100 ? 28 : 36,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--lf-text-primary, #e6e8eb)',
        }}
      >
        {lastRoll ? lastRoll.value : '—'}
      </div>
      <div style={{ minWidth: 0 }}>
        <p style={{ ...mutedStyle, margin: '0 0 4px 0', fontSize: 12 }}>
          {t('dice.lastRoll.heading')}
        </p>
        {lastRoll ? (
          <>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              {t('dice.lastRoll.byline', {
                name: displayNameFor(players, lastRoll.playerId),
                sides: lastRoll.sides,
              })}
            </p>
            <p style={{ ...mutedStyle, margin: '2px 0 0 0', fontSize: 12 }}>
              <span style={{ fontWeight: 700 }}>{lastRoll.value}</span>{' '}
              <time dateTime={lastRoll.at}>{relativeTime(lastRoll.at, now, t)}</time>
            </p>
          </>
        ) : (
          <p style={{ ...mutedStyle, margin: 0 }}>{t('dice.lastRoll.empty')}</p>
        )}
      </div>
    </div>
  );
}
