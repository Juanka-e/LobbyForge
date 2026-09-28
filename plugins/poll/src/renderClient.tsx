/**
 * Poll renderClient — the React panel the activity host renders once a
 * `poll` activity is running in a channel or voice room.
 *
 * Built from the activity UI kit (`@lobbyforge/plugin-sdk/ui`), which
 * styles itself from the host's theme variables: plugin files sit outside
 * the web app's Tailwind build, so a class name here would generate no CSS.
 *
 * Four things about this file are load-bearing:
 *
 *  1. **It is returned as an ELEMENT, never called.** `index.ts` wires
 *     it with `createElement(PollPanel, props)`. Invoking the component
 *     as a plain function appends its hooks to the CALLER's hook list;
 *     the host mounts the panel conditionally, so the hook count would
 *     change between renders and React would throw #310 — which takes
 *     the whole voice room down to its error boundary.
 *
 *  2. **The viewer never sees the ballot box.** `props.state` is a
 *     `PollViewState`: the canonical projector strips `ballotBox`
 *     server-side and hands the client `ballotCount` + `hasVoted`.
 *     Diffing two broadcast revisions used to de-anonymise every vote;
 *     this panel must therefore never reach for `ballotBox`.
 *
 *  3. **"Your vote" is this browser's memory, not the server's.** Nothing
 *     in the state says which option a viewer picked. The panel remembers
 *     the option it sent (session storage, keyed by poll and viewer) and
 *     marks it only once the server confirms the ballot (`hasVoted`).
 *
 *  4. **Every string is a `t()` call with a literal `poll.` key, in THIS
 *     file.** The locales test reads it to prove each key exists in every
 *     language and that no language ships a key nobody renders — so no
 *     computed keys, and no text in the helper modules.
 */

'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import {
  detectLocale,
  loadPluginLocale,
  pickBestLocale,
  tFor as tForShared,
} from '@lobbyforge/plugin-sdk';
import {
  ActivityHeader,
  ActivityShell,
  Badge,
  Button,
  Callout,
  EmptyState,
  Panel,
  PhasePill,
  Row,
  SectionLabel,
  Stack,
  lf,
  tone,
} from '@lobbyforge/plugin-sdk/ui';
import { LOCALE_TABLES } from './locales.generated';
import {
  POLL_PLUGIN_ID,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
} from './constants';
import type { PollAction, PollOption, PollViewState } from './index';
import { pollLeader } from './tally';
import {
  checkDraft,
  pollPhaseOf,
  resultsVisible,
  sharePercent,
  showTurnout,
  totalVotes,
  voteStorageKey,
  type PollPhase,
} from './view';

// Register the plugin's locale tables the moment the module loads.
// Adding a language is a one-line change: drop `locales/<lang>.json`
// in and run `pnpm i18n:sync`.
loadPluginLocale(POLL_PLUGIN_ID, LOCALE_TABLES);

export interface PollPanelClientProps {
  state: PollViewState;
  dispatch: (action: PollAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: Array<{ userId: string; name?: string | null }>;
  /** Hushle-specific host prop. Poll has no card packs — ignored. */
  cardPacks?: unknown;
}

export type PollPanelProps = PollPanelClientProps;

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Dispatch = PollPanelClientProps['dispatch'];

/**
 * How long a vote may stay "sending" before the choices unlock again. The
 * host's dispatch returns nothing to wait on, so a vote the server refused
 * (the poll closed in between) must not leave the options locked for good.
 */
const VOTE_PENDING_MS = 8_000;

/* ------------------------------------------------------------------ */
/* Styles — kit tokens only, so every theme (dark, dim, light) works.  */
/* ------------------------------------------------------------------ */

const listReset: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

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

/** The shared shape of a choice and of a result row: same size, so voting never reflows the list. */
function optionShell(border: string): CSSProperties {
  return {
    position: 'relative',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 56,
    margin: 0,
    padding: '12px 16px',
    borderRadius: 16,
    border: `2px solid ${border}`,
    background: lf.raised,
    color: lf.text,
    font: 'inherit',
    fontSize: 15,
    textAlign: 'left',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };
}

const optionText: CSSProperties = { fontSize: 15, lineHeight: 1.4, overflowWrap: 'anywhere', minWidth: 0 };

/** A tint laid over itself — twice as strong, still the theme's own colour. */
const doubled = (colour: string) => `linear-gradient(${colour}, ${colour}), ${colour}`;

function inputStyle(invalid: boolean): CSSProperties {
  return {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    minHeight: 44,
    padding: '10px 14px',
    borderRadius: 12,
    border: `1px solid ${invalid ? tone('danger').fill : lf.borderStrong}`,
    background: lf.sunken,
    color: lf.text,
    font: 'inherit',
    fontSize: 15,
  };
}

const errorText: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.4, color: tone('danger').text };

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function PollPanel(props: PollPanelProps): ReactNode {
  const { state, dispatch, actorUserId, hostUserId, players } = props;
  const isHost = hostUserId !== null && actorUserId === hostUserId;
  // Resolve the active locale against the languages the plugin has
  // actually registered, so a viewer on `fr` falls back to English
  // instead of seeing raw keys. The document language does not change
  // mid-session, so this runs once.
  const locale = useMemo(() => pickBestLocale(POLL_PLUGIN_ID, detectLocale('en')), []);
  const t: Translate = (key, params) => tForShared(POLL_PLUGIN_ID, locale, key, params);

  // The host hands us whatever the activity route returned; be
  // defensive about a half-migrated or empty state blob.
  const phase = pollPhaseOf(state?.phase);
  const options: PollOption[] = Array.isArray(state?.options) ? state.options : [];
  const ballotCount = Number(state?.ballotCount) || 0;
  const hasVoted = state?.hasVoted === true;

  const status =
    phase === 'open' ? (
      <PhasePill tone="success" live>
        {t('poll.phase.open')}
      </PhasePill>
    ) : phase === 'closed' ? (
      <PhasePill tone="neutral">{t('poll.phase.closed')}</PhasePill>
    ) : (
      <PhasePill tone="neutral">{t('poll.phase.idle')}</PhasePill>
    );

  // Host controls live in the header, where the kit puts a panel's
  // actions — offered exactly as the reducer allows them: close an open
  // poll; reopen a closed one (the ballot box survives, so nobody votes
  // twice across the gap); or clear it to write a new one.
  let actions: ReactNode = null;
  if (isHost && phase === 'open') {
    actions = (
      <Button size="sm" variant="secondary" onClick={() => void dispatch({ type: 'close-poll', hostId: actorUserId })}>
        {t('poll.open.closeButton')}
      </Button>
    );
  } else if (isHost && phase === 'closed') {
    actions = (
      <>
        <Button size="sm" variant="secondary" onClick={() => void dispatch({ type: 'reopen-poll', hostId: actorUserId })}>
          {t('poll.closed.reopenButton')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void dispatch({ type: 'clear-poll', hostId: actorUserId })}>
          {t('poll.closed.newButton')}
        </Button>
      </>
    );
  }

  let body: ReactNode;
  if (phase === 'idle') {
    body = isHost ? (
      <ComposePoll t={t} actorUserId={actorUserId} dispatch={dispatch} />
    ) : (
      <EmptyState icon={<BallotIcon />} title={t('poll.phase.idle')} body={t('poll.compose.waitingForHost')} />
    );
  } else {
    body = (
      <LivePoll
        t={t}
        phase={phase}
        question={typeof state?.question === 'string' && state.question.trim() ? state.question : t('poll.noQuestion')}
        options={options}
        ballotCount={ballotCount}
        hasVoted={hasVoted}
        playerCount={Array.isArray(players) ? players.length : 0}
        createdAt={typeof state?.createdAt === 'string' ? state.createdAt : null}
        actorUserId={actorUserId}
        dispatch={dispatch}
      />
    );
  }

  return (
    <ActivityShell role="region" aria-label={t('poll.title')}>
      <ActivityHeader
        glyph="P"
        tone="neutral"
        title={t('poll.title')}
        subtitle={t('poll.tagline')}
        status={status}
        actions={actions}
      />
      {body}
    </ActivityShell>
  );
}

/* ------------------------------------------------------------------ */
/* open / closed — voting and results                                  */
/* ------------------------------------------------------------------ */

function readVote(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeVote(key: string, optionId: string): void {
  try {
    window.sessionStorage.setItem(key, optionId);
  } catch {
    // Private mode or a full quota: the mark simply won't survive a reload.
  }
}

/**
 * Which option this viewer picked, as far as this browser knows, plus the
 * vote in flight. `mine` is only ever reported once the server confirms a
 * ballot, so a refused vote never shows up as "Your vote".
 */
function useOwnVote(createdAt: string | null, actorUserId: string, hasVoted: boolean) {
  const key = createdAt && actorUserId ? voteStorageKey(createdAt, actorUserId) : null;
  const [remembered, setRemembered] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Guards a second click landing before the re-render that disables the choices.
  const pendingRef = useRef<string | null>(null);

  // Storage is read after mount, never during render: the server render
  // has no storage, and the two must agree.
  useEffect(() => {
    setRemembered(key ? readVote(key) : null);
    pendingRef.current = null;
    setPending(null);
  }, [key]);

  useEffect(() => {
    if (pending === null) return;
    if (hasVoted) {
      if (key) writeVote(key, pending);
      setRemembered(pending);
      pendingRef.current = null;
      setPending(null);
      return;
    }
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setPending(null);
    }, VOTE_PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, hasVoted, key]);

  const begin = (optionId: string): boolean => {
    if (hasVoted || pendingRef.current !== null) return false;
    pendingRef.current = optionId;
    setPending(optionId);
    return true;
  };

  return { mine: hasVoted ? remembered : null, pending, begin };
}

function LivePoll({
  t,
  phase,
  question,
  options,
  ballotCount,
  hasVoted,
  playerCount,
  createdAt,
  actorUserId,
  dispatch,
}: {
  t: Translate;
  phase: Exclude<PollPhase, 'idle'>;
  question: string;
  options: PollOption[];
  ballotCount: number;
  hasVoted: boolean;
  playerCount: number;
  createdAt: string | null;
  actorUserId: string;
  dispatch: Dispatch;
}): ReactNode {
  const isOpen = phase === 'open';
  // Once the viewer has voted — or the poll has closed — there is nothing
  // left to choose, so the choices turn into the results read-out.
  const showResults = resultsVisible(phase, hasVoted);
  const total = totalVotes(options);
  const leaderId = pollLeader({ options });
  const vote = useOwnVote(createdAt, actorUserId, hasVoted);

  const hint = !isOpen
    ? t('poll.closed.title')
    : hasVoted
      ? t('poll.open.voted')
      : vote.pending
        ? t('poll.open.sending')
        : t('poll.open.voteHint');

  const cast = (optionId: string) => {
    if (!vote.begin(optionId)) return;
    void dispatch({ type: 'vote', playerId: actorUserId, optionId });
  };

  return (
    <Panel>
      <Stack gap={18}>
        <Stack gap={6}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{question}</h2>
          {/* A status region: "Your vote is in" is announced when it lands. */}
          <p role="status" style={mutedText}>
            {hint}
          </p>
        </Stack>

        {showResults ? (
          <ResultList t={t} options={options} total={total} leaderId={leaderId} isClosed={!isOpen} mine={vote.mine} />
        ) : (
          <ChoiceList t={t} options={options} pending={vote.pending} onChoose={cast} />
        )}

        {!isOpen && total === 0 ? <Callout tone="neutral">{t('poll.closed.noVotes')}</Callout> : null}
        {!isOpen && total > 0 && leaderId === null ? <Callout tone="info">{t('poll.results.tie')}</Callout> : null}

        <p style={{ ...mutedText, color: lf.muted }}>
          {showTurnout(playerCount, ballotCount)
            ? t('poll.footer.turnout', { count: ballotCount, total: playerCount })
            : t('poll.footer.total', { count: ballotCount })}
        </p>
      </Stack>
    </Panel>
  );
}

/** Before voting: plain choices, no tally to sway anyone. */
function ChoiceList({
  t,
  options,
  pending,
  onChoose,
}: {
  t: Translate;
  options: PollOption[];
  pending: string | null;
  onChoose: (optionId: string) => void;
}): ReactNode {
  return (
    <ul style={listReset}>
      {options.map((option) => {
        const chosen = pending === option.id;
        return (
          <li key={option.id}>
            <button
              type="button"
              className="lfui-option lfui-focus"
              // The visible label is the option text; the accessible name
              // contains it verbatim (WCAG 2.5.3).
              aria-label={t('poll.open.voteFor', { option: option.text })}
              disabled={pending !== null}
              onClick={() => onChoose(option.id)}
              style={{
                ...optionShell(chosen ? 'var(--lfui-accent)' : lf.border),
                opacity: pending !== null && !chosen ? 0.6 : 1,
              }}
            >
              <span style={optionText}>{option.text}</span>
              <span
                aria-hidden="true"
                style={{
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  boxSizing: 'border-box',
                  borderRadius: 99,
                  border: `2px solid ${chosen ? 'var(--lfui-accent)' : lf.borderStrong}`,
                  background: chosen ? 'var(--lfui-accent)' : 'transparent',
                }}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** After voting, and for everyone once the poll closes: each row fills with its share. */
function ResultList({
  t,
  options,
  total,
  leaderId,
  isClosed,
  mine,
}: {
  t: Translate;
  options: PollOption[];
  total: number;
  leaderId: string | null;
  isClosed: boolean;
  mine: string | null;
}): ReactNode {
  const accent = tone('accent');
  const success = tone('success');
  return (
    <ul style={listReset}>
      {options.map((option) => {
        const votes = Number(option.votes) || 0;
        const share = sharePercent(votes, total);
        const isMine = mine === option.id;
        const isWinner = isClosed && option.id === leaderId;
        const isLeading = !isClosed && option.id === leaderId;
        const border = isWinner ? success.line : isMine ? 'var(--lfui-accent)' : lf.border;
        const fill = isWinner ? doubled(success.soft) : isMine ? doubled(accent.soft) : accent.soft;
        return (
          <li key={option.id} style={optionShell(border)}>
            {/* Decorative: every number it draws is in the text beside it. */}
            <span
              aria-hidden="true"
              className="lfui-bar-fill"
              style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${share}%`, background: fill }}
            />
            {/* The {' '}s keep the words apart in the text (copy, find, a
                screen reader's reading); whitespace inside a flex row is not drawn. */}
            <span style={{ position: 'relative', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
              <span style={{ ...optionText, fontWeight: isWinner ? 600 : 500 }}>{option.text}</span>{' '}
              {isMine ? <Badge tone="accent">{t('poll.results.yourVote')}</Badge> : null}{' '}
              {isWinner ? <Badge tone="success">{t('poll.results.winner')}</Badge> : null}{' '}
              {isLeading ? <Badge tone="info">{t('poll.results.leader')}</Badge> : null}
            </span>{' '}
            <span style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0, whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 13, color: lf.text2 }}>{t('poll.results.votes', { count: votes })}</span>{' '}
              <span style={{ minWidth: '3.2em', textAlign: 'right', fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {t('poll.results.share', { percent: share })}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* idle — the host composes a poll                                     */
/* ------------------------------------------------------------------ */

interface DraftRow {
  /** Stable across removals, so focus and typing stay on the right row. */
  id: number;
  text: string;
}

function ComposePoll({ t, actorUserId, dispatch }: { t: Translate; actorUserId: string; dispatch: Dispatch }): ReactNode {
  const baseId = useId();
  const idFor = (part: string) => `${baseId}-${part}`;
  const nextRowId = useRef(POLL_MIN_OPTIONS + 1);
  const [question, setQuestion] = useState('');
  const [rows, setRows] = useState<DraftRow[]>(() =>
    Array.from({ length: POLL_MIN_OPTIONS }, (_, index) => ({ id: index + 1, text: '' }))
  );
  // Errors wait for the first "Open poll" — nobody wants to be told off
  // while they are still typing — then follow the fields live.
  const [submitted, setSubmitted] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);

  useEffect(() => {
    if (focusTarget === null) return;
    document.getElementById(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const check = checkDraft(
    question,
    rows.map((row) => row.text)
  );
  const questionError = submitted && check.questionProblem ? t('poll.error.questionRequired') : null;
  const optionsError = !submitted
    ? null
    : check.optionsProblem === 'optionsRequired'
      ? t('poll.error.optionsRequired', { min: POLL_MIN_OPTIONS })
      : check.optionsProblem === 'duplicateOption'
        ? t('poll.error.duplicateOption')
        : null;
  const badRowId = optionsError ? rows[check.optionsProblemIndex]?.id : undefined;

  const canAdd = rows.length < POLL_MAX_OPTIONS;
  const canRemove = rows.length > POLL_MIN_OPTIONS;

  const addRow = () => {
    if (!canAdd) return;
    const id = nextRowId.current;
    nextRowId.current += 1;
    setRows((prev) => [...prev, { id, text: '' }]);
    setFocusTarget(idFor(`option-${id}`));
  };

  const removeRow = (index: number) => {
    if (!canRemove) return;
    // Keep keyboard focus in the list: move to the row that takes this one's place.
    const neighbour = rows[index + 1] ?? rows[index - 1];
    setRows((prev) => prev.filter((_, i) => i !== index));
    if (neighbour) setFocusTarget(idFor(`option-${neighbour.id}`));
  };

  const setRowText = (id: number, text: string) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, text: text.slice(0, POLL_MAX_OPTION_LENGTH) } : row)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!check.ok) {
      // Take the host straight to the first thing that needs fixing.
      const row = rows[check.optionsProblemIndex];
      setFocusTarget(check.questionProblem ? idFor('question') : row ? idFor(`option-${row.id}`) : null);
      return;
    }
    void dispatch({ type: 'open-poll', hostId: actorUserId, question: check.question, options: check.options });
  };

  const questionDescribedBy = [questionError ? idFor('question-error') : null, idFor('question-count')]
    .filter(Boolean)
    .join(' ');

  return (
    <Panel>
      <form onSubmit={submit} noValidate>
        <Stack gap={20} style={{ maxWidth: 680 }}>
          <Stack gap={6}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t('poll.compose.title')}</h2>
            <p style={mutedText}>{t('poll.compose.hostPrompt')}</p>
          </Stack>

          <Stack gap={6}>
            <label htmlFor={idFor('question')} style={{ fontSize: 13, fontWeight: 500, color: lf.text2 }}>
              {t('poll.compose.questionLabel')}
            </label>
            <input
              id={idFor('question')}
              className="lfui-focus"
              value={question}
              maxLength={POLL_MAX_QUESTION_LENGTH}
              placeholder={t('poll.compose.questionPlaceholder')}
              aria-invalid={questionError ? true : undefined}
              aria-describedby={questionDescribedBy}
              onChange={(event) => setQuestion(event.target.value.slice(0, POLL_MAX_QUESTION_LENGTH))}
              style={inputStyle(Boolean(questionError))}
            />
            {questionError ? (
              <p id={idFor('question-error')} style={errorText}>
                {questionError}
              </p>
            ) : null}
            <span id={idFor('question-count')} style={{ fontSize: 12, color: lf.muted }}>
              {t('poll.compose.remaining', { count: POLL_MAX_QUESTION_LENGTH - question.length })}
            </span>
          </Stack>

          <fieldset
            aria-describedby={optionsError ? idFor('options-error') : undefined}
            style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
          >
            <legend style={{ padding: 0, marginBottom: 10 }}>
              <SectionLabel>{t('poll.compose.optionsLabel')}</SectionLabel>
            </legend>
            <Stack gap={8}>
              {rows.map((row, index) => {
                const inputId = idFor(`option-${row.id}`);
                const invalid = row.id === badRowId;
                return (
                  <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 28,
                        height: 28,
                        flexShrink: 0,
                        borderRadius: 9,
                        background: lf.raised,
                        color: lf.text2,
                        fontSize: 13,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {index + 1}
                    </span>
                    <label htmlFor={inputId} style={visuallyHidden}>
                      {t('poll.compose.optionLabel', { index: index + 1 })}
                    </label>
                    <input
                      id={inputId}
                      className="lfui-focus"
                      value={row.text}
                      maxLength={POLL_MAX_OPTION_LENGTH}
                      placeholder={t('poll.compose.optionPlaceholder', { index: index + 1 })}
                      aria-invalid={invalid ? true : undefined}
                      onChange={(event) => setRowText(row.id, event.target.value)}
                      style={{ ...inputStyle(invalid), flex: '1 1 auto' }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(index)}
                      disabled={!canRemove}
                      aria-label={t('poll.compose.removeOption', { index: index + 1 })}
                      title={t('poll.compose.removeOption', { index: index + 1 })}
                      style={{ flexShrink: 0, width: 36, padding: 0 }}
                    >
                      <CrossIcon />
                    </Button>
                  </div>
                );
              })}
            </Stack>
          </fieldset>
          {optionsError ? (
            <p id={idFor('options-error')} style={errorText}>
              {optionsError}
            </p>
          ) : null}

          <Row wrap gap={12}>
            <Button variant="secondary" size="sm" onClick={addRow} disabled={!canAdd}>
              <PlusIcon />
              {t('poll.compose.addOption')}
            </Button>
            <span style={{ fontSize: 13, color: lf.muted }}>
              {t('poll.compose.optionLimit', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS })}
            </span>
          </Row>

          <div>
            <Button type="submit" size="lg">
              {t('poll.compose.openButton')}
            </Button>
          </div>
        </Stack>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Icons — decorative; every control that uses one has a text name.    */
/* ------------------------------------------------------------------ */

function BallotIcon(): ReactNode {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 13h16v7H4z" />
      <path d="M8 13V5h8v8" />
      <path d="M10 9l1.5 1.5L14 8" />
    </svg>
  );
}

function CrossIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function PlusIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
