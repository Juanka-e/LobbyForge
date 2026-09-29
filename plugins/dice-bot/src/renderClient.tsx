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
 * reducer (server-side), so a client can only ask for a roll —
 * `{ type: 'roll', playerId, sides }` — and render whatever comes back.
 * The die picker is limited to values the reducer accepts so the
 * server-side clamp is never the thing correcting the UI.
 *
 * Built from the activity UI kit (`@lobbyforge/plugin-sdk/ui`), which
 * styles itself from the host's theme variables: plugin files sit outside
 * the web app's Tailwind build, so a class name here would generate no CSS.
 * The one thing the kit cannot give an inline style is the dice's own
 * tumble, so this file ships a few lines of keyframes — switched off, like
 * the kit's, for anyone who asked for reduced motion.
 *
 * Every string is a `t()` call with a literal `dice.` key, in THIS file:
 * the locales test reads it to prove each key exists in every language and
 * that no language ships a key nobody renders.
 */

'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  detectLocale,
  loadPluginLocale,
  pickBestLocale,
  tFor as tForShared,
} from '@lobbyforge/plugin-sdk';
import {
  ActivityHeader,
  ActivityShell,
  Avatar,
  Badge,
  Button,
  Callout,
  Grid,
  Panel,
  PhasePill,
  Row,
  SectionLabel,
  SegmentedControl,
  Stack,
  lf,
  tone,
  useNow,
} from '@lobbyforge/plugin-sdk/ui';
import { LOCALE_TABLES } from './locales.generated';
import { DICE_PLUGIN_ID } from './constants';
import type { DiceAction, DiceRoll, DiceState } from './index';
import {
  DICE_DEFAULT_SIDES,
  DICE_DIE_SIZES,
  diceStatRows,
  elapsedSince,
  isDiceRoll,
  recentRolls,
  type DiceStatRow,
  type Elapsed,
} from './view';

export { DICE_DIE_SIZES } from './view';

// Register the plugin's locale tables with the shared SDK registry.
// Adding a language is a one-liner: drop `locales/<lang>.json` in and
// run `pnpm i18n:sync`.
loadPluginLocale(DICE_PLUGIN_ID, LOCALE_TABLES);

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
type Dispatch = DicePanelClientProps['dispatch'];

/**
 * How long "Rolling…" may wait for the server before the button unlocks
 * again. The host's dispatch returns nothing to wait on, so a refused roll
 * (rolling paused in between) must not leave the button locked for good.
 */
const ROLL_PENDING_MS = 4_000;

/*
 * The dice's own motion. Scoped by the `lfdice-` prefix; the kit's
 * `.lfui *` reduced-motion rule already covers it, and it says so itself
 * too, so it stays still even if the kit's rule ever changes.
 */
const DICE_CSS = `
@keyframes lfdice-tumble{0%{transform:translateY(-14px) rotate(-200deg) scale(.6);opacity:0}60%{transform:translateY(2px) rotate(14deg) scale(1.06);opacity:1}100%{transform:none;opacity:1}}
@keyframes lfdice-shake{0%,100%{transform:rotate(0)}25%{transform:rotate(-12deg)}75%{transform:rotate(12deg)}}
.lfdice-tumble{animation:lfdice-tumble .6s cubic-bezier(.2,.8,.2,1)}
.lfdice-shake{animation:lfdice-shake .35s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.lfdice-tumble,.lfdice-shake{animation:none}}
.force-reduced-motion .lfdice-tumble,.force-reduced-motion .lfdice-shake{animation:none}
`;

/* ---------------------------------------------------------------- styles */

const mutedText: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: lf.text2 };

/** Present to screen readers, invisible on screen. */
const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const ellipsis: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/* --------------------------------------------------------------- helpers */

/** A player's name, or the start of their id when the host does not know it. */
export function displayNameFor(players: DicePanelPlayer[], userId: string | null): string {
  if (!userId) return '—';
  const match = players.find((p) => p.userId === userId);
  const name = match?.name?.trim();
  return name && name.length > 0 ? name : userId.slice(0, 8);
}

function formatElapsed(t: Translate, elapsed: Elapsed | null): string {
  if (!elapsed) return '';
  switch (elapsed.unit) {
    case 'now':
      return t('dice.time.now');
    case 'seconds':
      return t('dice.time.seconds', { count: elapsed.count });
    case 'minutes':
      return t('dice.time.minutes', { count: elapsed.count });
    case 'hours':
      return t('dice.time.hours', { count: elapsed.count });
    default:
      return t('dice.time.days', { count: elapsed.count });
  }
}

/**
 * The viewer's own roll in flight: set on click, cleared when that roll
 * lands, when an async dispatch settles, or after `ROLL_PENDING_MS`.
 */
function useRolling(lastRoll: DiceRoll | null, actorUserId: string) {
  const [pendingFrom, setPendingFrom] = useState<{ at: string | null } | null>(null);
  // Guards a second click landing before the re-render that disables the button.
  const pendingRef = useRef(false);
  const lastAt = lastRoll?.at ?? null;
  const lastBy = lastRoll?.playerId ?? null;

  useEffect(() => {
    if (!pendingFrom) return;
    if (lastAt !== pendingFrom.at && lastBy === actorUserId) {
      pendingRef.current = false;
      setPendingFrom(null);
      return;
    }
    const timer = setTimeout(() => {
      pendingRef.current = false;
      setPendingFrom(null);
    }, ROLL_PENDING_MS);
    return () => clearTimeout(timer);
  }, [pendingFrom, lastAt, lastBy, actorUserId]);

  return {
    active: pendingFrom !== null,
    start: (): boolean => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPendingFrom({ at: lastAt });
      return true;
    },
    settle: () => {
      pendingRef.current = false;
      setPendingFrom(null);
    },
  };
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
  const t: Translate = (key, params) => tForShared(DICE_PLUGIN_ID, locale, key, params);
  const now = useNow(1000);

  // The host hands over raw JSON; be defensive about a half-migrated blob.
  const enabled = state?.enabled === true;
  const lastRoll = isDiceRoll(state?.lastRoll) ? state.lastRoll : null;
  const feed = recentRolls(state?.history);
  const statRows = useMemo(() => diceStatRows(state?.stats), [state?.stats]);
  const roster = Array.isArray(players) ? players : [];

  // A name for every roller. The host registers only the session's
  // creator as a player today, so the viewer's own rows fall back to
  // "You" rather than to the start of their id.
  const nameOf = (userId: string): string => {
    const known = roster.find((p) => p.userId === userId)?.name?.trim();
    if (known) return known;
    return userId === actorUserId ? t('dice.stats.you') : displayNameFor(roster, userId);
  };
  const bylineOf = (roll: DiceRoll): string =>
    roll.playerId === actorUserId
      ? t('dice.lastRoll.bylineYou', { sides: roll.sides, value: roll.value })
      : t('dice.lastRoll.byline', { name: nameOf(roll.playerId), sides: roll.sides, value: roll.value });
  const ago = (iso: string) => formatElapsed(t, elapsedSince(iso, now));

  const [sides, setSides] = useState<number>(DICE_DEFAULT_SIDES);
  const rolling = useRolling(lastRoll, actorUserId);
  const canRoll = enabled && !rolling.active && actorUserId.length > 0;

  const roll = () => {
    if (!canRoll || !rolling.start()) return;
    const result = dispatch({ type: 'roll', playerId: actorUserId, sides });
    // The host's dispatch is fire-and-forget (returns void); an async one
    // releases the button as soon as it answers.
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(rolling.settle, rolling.settle);
    }
  };

  // Only a roll that lands while the panel is open tumbles in — not the
  // one already on the table when it mounts.
  const firstSeenAt = useRef(lastRoll?.at ?? null);
  const fresh = lastRoll !== null && lastRoll.at !== firstSeenAt.current;

  const averageFormat = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [locale]
  );

  return (
    <ActivityShell role="region" aria-label={t('dice.title')}>
      {/* React 19 hoists this into <head> once, like the kit's own sheet. */}
      <style href="lfdice-v1" precedence="lfui">
        {DICE_CSS}
      </style>
      <ActivityHeader
        glyph="D"
        tone="game"
        title={t('dice.title')}
        subtitle={t('dice.tagline')}
        status={
          enabled ? (
            <PhasePill tone="success" live>
              {t('dice.status.enabled')}
            </PhasePill>
          ) : (
            <PhasePill tone="neutral">{t('dice.status.disabled')}</PhasePill>
          )
        }
      />

      {enabled ? null : (
        <Callout tone="game" role="status">
          {t('dice.paused.notice')}
        </Callout>
      )}

      <Grid min={320} gap={16}>
        <Stack gap={16}>
          <Panel>
            <Stack gap={18}>
              <Panel variant="raised" padding={18}>
                <Row gap={18}>
                  <DieFace
                    key={lastRoll?.at ?? 'none'}
                    value={lastRoll?.value ?? null}
                    className={rolling.active ? 'lfdice-shake' : fresh ? 'lfdice-tumble' : undefined}
                  />
                  <Stack gap={4} style={{ flex: '1 1 auto' }}>
                    <SectionLabel>{t('dice.lastRoll.heading')}</SectionLabel>
                    {/* Announced politely whenever anyone's roll lands. */}
                    <p role="status" style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                      {lastRoll ? bylineOf(lastRoll) : t('dice.lastRoll.empty')}
                    </p>
                    {lastRoll ? (
                      <time dateTime={lastRoll.at} style={{ fontSize: 13, color: lf.text2 }}>
                        {ago(lastRoll.at)}
                      </time>
                    ) : null}
                  </Stack>
                </Row>
              </Panel>

              <Stack gap={8}>
                <SectionLabel>{t('dice.roll.dieLabel')}</SectionLabel>
                <SegmentedControl
                  label={t('dice.roll.dieLabel')}
                  value={String(sides)}
                  onChange={(value) => setSides(Number(value))}
                  options={DICE_DIE_SIZES.map((size) => ({ value: String(size), label: t('dice.die.name', { sides: size }) }))}
                />
              </Stack>

              <Button
                variant="game"
                size="lg"
                block
                onClick={roll}
                disabled={!canRoll}
                aria-busy={rolling.active || undefined}
                aria-label={rolling.active ? undefined : t('dice.roll.buttonAria', { sides })}
              >
                <DieGlyph />
                {rolling.active ? t('dice.roll.busy') : t('dice.roll.button', { sides })}
              </Button>
            </Stack>
          </Panel>

          <Panel>
            <Stack gap={12}>
              <SectionLabel>{t('dice.stats.heading')}</SectionLabel>
              {statRows.length === 0 ? (
                <p style={mutedText}>{t('dice.stats.empty')}</p>
              ) : (
                <StatsTable
                  t={t}
                  rows={statRows}
                  actorUserId={actorUserId}
                  nameOf={nameOf}
                  formatAverage={(value) => averageFormat.format(value)}
                />
              )}
            </Stack>
          </Panel>
        </Stack>

        <Stack gap={16}>
          <Panel>
            <Stack gap={12}>
              <SectionLabel>{t('dice.history.heading')}</SectionLabel>
              {feed.visible.length === 0 ? (
                <p style={mutedText}>{t('dice.history.empty')}</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {feed.visible.map((entry, index) => {
                    const name = nameOf(entry.playerId);
                    return (
                      <li
                        key={`${entry.at}-${entry.playerId}-${index}`}
                        style={{
                          position: 'relative',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '8px 12px',
                          borderRadius: 12,
                          background: entry.playerId === actorUserId ? tone('accent').soft : lf.raised,
                        }}
                      >
                        {/* One sentence for screen readers; the row beside it is its picture. */}
                        <span style={visuallyHidden}>{bylineOf(entry)}</span>{' '}
                        <Avatar name={name} size={28} />
                        <span aria-hidden="true" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ ...ellipsis, fontSize: 14, fontWeight: 500 }}>{name}</span>{' '}
                          <span style={{ fontSize: 12, color: lf.muted }}>{t('dice.die.name', { sides: entry.sides })}</span>
                        </span>{' '}
                        <span aria-hidden="true" style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                          {entry.value}
                        </span>{' '}
                        <time
                          dateTime={entry.at}
                          style={{ minWidth: '5.5em', textAlign: 'right', fontSize: 12, color: lf.muted, whiteSpace: 'nowrap' }}
                        >
                          {ago(entry.at)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              )}
              {feed.hidden > 0 ? (
                <p style={{ ...mutedText, fontSize: 13, color: lf.muted }}>{t('dice.history.more', { count: feed.hidden })}</p>
              ) : null}
            </Stack>
          </Panel>

          {isHost ? <HostControls t={t} enabled={enabled} actorUserId={actorUserId} dispatch={dispatch} /> : null}
        </Stack>
      </Grid>
    </ActivityShell>
  );
}

/* ------------------------------------------------------------ pieces */

/**
 * The rolled number on a die. It takes the theme's text and surface
 * colours the other way round — a light die on the dark themes, a dark one
 * on light — so it always stands out from the card it sits on.
 */
function DieFace({ value, className }: { value: number | null; className?: string }): ReactNode {
  const base: CSSProperties = {
    width: 64,
    height: 64,
    flexShrink: 0,
    boxSizing: 'border-box',
    borderRadius: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
  };
  if (value === null) {
    return (
      <span aria-hidden="true" style={{ ...base, border: `2px dashed ${lf.borderStrong}`, color: lf.muted, fontSize: 26 }}>
        ?
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        ...base,
        background: lf.text,
        color: lf.surface,
        fontSize: String(value).length >= 3 ? 22 : 30,
        boxShadow: 'inset 0 -4px 0 rgba(0,0,0,.22)',
      }}
    >
      {value}
    </span>
  );
}

function StatsTable({
  t,
  rows,
  actorUserId,
  nameOf,
  formatAverage,
}: {
  t: Translate;
  rows: DiceStatRow[];
  actorUserId: string;
  nameOf: (userId: string) => string;
  formatAverage: (value: number) => string;
}): ReactNode {
  // Tight between columns, roomier at the row's rounded ends: four columns
  // have to fit a ~260px phone card, in languages with longer headings too.
  const inset = (edge: 'first' | 'last' | null, vertical: number) =>
    edge === 'first' ? `${vertical}px 8px ${vertical}px 12px` : edge === 'last' ? `${vertical}px 12px ${vertical}px 8px` : `${vertical}px 8px`;
  const head = (edge: 'first' | 'last' | null): CSSProperties => ({
    padding: inset(edge, 0),
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: lf.muted,
    textAlign: 'right',
    whiteSpace: 'nowrap',
  });
  const cell = (mine: boolean, edge: 'first' | 'last' | null): CSSProperties => ({
    padding: inset(edge, 10),
    background: mine ? tone('accent').soft : lf.raised,
    color: lf.text2,
    fontSize: 14,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
    borderRadius: edge === 'first' ? '12px 0 0 12px' : edge === 'last' ? '0 12px 12px 0' : 0,
  });
  return (
    <table
      aria-label={t('dice.stats.heading')}
      style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 6px', margin: '-6px 0' }}
    >
      <thead>
        <tr>
          <th scope="col" style={{ ...head('first'), textAlign: 'left', width: '100%' }}>
            {t('dice.stats.player')}
          </th>
          <th scope="col" style={head(null)}>
            {t('dice.stats.rolls')}
          </th>
          <th scope="col" style={head(null)}>
            {t('dice.stats.average')}
          </th>
          <th scope="col" style={head('last')}>
            {t('dice.stats.best')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const mine = row.userId === actorUserId;
          const name = nameOf(row.userId);
          return (
            <tr key={row.userId}>
              <th scope="row" style={{ ...cell(mine, 'first'), textAlign: 'left', whiteSpace: 'normal', color: lf.text, fontWeight: 500 }}>
                {/* The {' '}s keep the words apart in the text (copy, find,
                    text matching); whitespace inside a flex row is not drawn. */}
                <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
                  <span style={{ overflowWrap: 'anywhere' }}>{name}</span>
                  {mine && name !== t('dice.stats.you') ? (
                    <>
                      {' '}
                      <Badge tone="accent">{t('dice.stats.you')}</Badge>
                    </>
                  ) : null}
                  {index === 0 ? (
                    <>
                      {' '}
                      <Badge tone="game">{t('dice.stats.leader')}</Badge>
                    </>
                  ) : null}
                </span>
              </th>
              <td style={cell(mine, null)}>{row.rolls}</td>
              <td style={cell(mine, null)}>{formatAverage(row.average)}</td>
              <td style={{ ...cell(mine, 'last'), color: lf.text, fontWeight: 700 }}>{row.best}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Pause/resume, reset scores and clear the log. The two that erase
 * something ask first, in place: the question takes focus, Escape or
 * "Cancel" backs out, and focus returns to the button that asked.
 */
function HostControls({
  t,
  enabled,
  actorUserId,
  dispatch,
}: {
  t: Translate;
  enabled: boolean;
  actorUserId: string;
  dispatch: Dispatch;
}): ReactNode {
  const baseId = useId();
  const idFor = (part: string) => `${baseId}-${part}`;
  const [confirming, setConfirming] = useState<'reset' | 'clear' | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);

  useEffect(() => {
    if (focusTarget === null) return;
    document.getElementById(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const ask = (what: 'reset' | 'clear') => {
    setConfirming(what);
    setFocusTarget(idFor('cancel'));
  };
  const close = () => {
    if (confirming) setFocusTarget(idFor(confirming));
    setConfirming(null);
  };
  const confirm = () => {
    if (confirming === 'reset') void dispatch({ type: 'reset-stats', hostId: actorUserId });
    if (confirming === 'clear') void dispatch({ type: 'clear-history', hostId: actorUserId });
    close();
  };

  return (
    <Panel>
      <Stack gap={12}>
        <SectionLabel>{t('dice.host.heading')}</SectionLabel>
        <Row wrap gap={8}>
          <Button
            variant="secondary"
            size="sm"
            // `set-enabled`, not `toggle`: a flip computed from a snapshot
            // that has already moved would set the wrong value.
            onClick={() => void dispatch({ type: 'set-enabled', hostId: actorUserId, enabled: !enabled })}
            aria-label={enabled ? t('dice.host.disableAria') : t('dice.host.enableAria')}
          >
            {enabled ? t('dice.host.disable') : t('dice.host.enable')}
          </Button>
          <Button
            id={idFor('reset')}
            variant="danger"
            size="sm"
            onClick={() => ask('reset')}
            aria-label={t('dice.host.resetAria')}
            aria-expanded={confirming === 'reset'}
            aria-controls={confirming === 'reset' ? idFor('confirm') : undefined}
          >
            {t('dice.host.reset')}
          </Button>
          <Button
            id={idFor('clear')}
            variant="danger"
            size="sm"
            onClick={() => ask('clear')}
            aria-label={t('dice.host.clearHistoryAria')}
            aria-expanded={confirming === 'clear'}
            aria-controls={confirming === 'clear' ? idFor('confirm') : undefined}
          >
            {t('dice.host.clearHistory')}
          </Button>
        </Row>
        {confirming ? (
          <div
            id={idFor('confirm')}
            role="group"
            aria-labelledby={idFor('confirm-text')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
            }}
            style={{
              padding: 14,
              borderRadius: 14,
              background: lf.raised,
              border: `1px solid ${tone('danger').line}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <p id={idFor('confirm-text')} style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              {confirming === 'reset' ? t('dice.host.confirmReset') : t('dice.host.confirmClear')}
            </p>
            <Row wrap gap={8}>
              <Button variant="danger" size="sm" onClick={confirm}>
                {confirming === 'reset' ? t('dice.host.confirmResetButton') : t('dice.host.confirmClearButton')}
              </Button>
              <Button id={idFor('cancel')} variant="ghost" size="sm" onClick={close}>
                {t('dice.host.cancel')}
              </Button>
            </Row>
          </div>
        ) : (
          <p style={{ ...mutedText, fontSize: 13, color: lf.muted }}>{t('dice.host.resetHint')}</p>
        )}
      </Stack>
    </Panel>
  );
}

/** A small die for the Roll button; decorative, the button has text. */
function DieGlyph(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
