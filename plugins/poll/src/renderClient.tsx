/**
 * Poll renderClient — the React panel the activity host renders once a
 * `poll` activity is running in a channel or voice room.
 *
 * Three things about this file are load-bearing:
 *
 *  1. **It is returned as an ELEMENT, never called.** `index.ts` wires
 *     it with `createElement(PollPanel, props)`. Invoking the component
 *     as a plain function appends its hooks to the CALLER's hook list;
 *     the host mounts the panel conditionally, so the hook count would
 *     change between renders and React would throw #310 — which takes
 *     the whole voice room down to its error boundary.
 *
 *  2. **No Tailwind.** Plugin directories sit outside the web app's
 *     Tailwind `content` globs, so a class name here generates no CSS.
 *     Everything is inline styles, and every colour reads the host's
 *     `--lf-*` theme variables with the dark value as the fallback, so
 *     the panel follows the light theme instead of staying a dark
 *     island with invisible headings.
 *
 *  3. **The viewer never sees the ballot box.** `props.state` is a
 *     `PollViewState`: the canonical projector strips `ballotBox`
 *     server-side and hands the client `ballotCount` + `hasVoted`.
 *     Diffing two broadcast revisions used to de-anonymise every vote;
 *     this panel must therefore never reach for `ballotBox`.
 */

'use client';

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  tFor as tForShared,
  pickBestLocale,
  detectLocale,
  loadPluginLocale,
} from '@lobbyforge/plugin-sdk';
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

// Register the plugin's locale tables the moment the module loads.
// Adding a language is a one-line change: drop `locales/<lang>.json`
// in and add it to the map below.
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

function tFor(locale: string, key: string, params?: Record<string, string | number>): string {
  return tForShared(POLL_PLUGIN_ID, locale, key, params);
}

/* ------------------------------------------------------------------ */
/* Styles — theme variables first, dark-theme hex as the fallback.     */
/* ------------------------------------------------------------------ */

const cardStyle: CSSProperties = {
  background: 'var(--lf-surface, #0e1218)',
  // Without an explicit colour the headings inside inherit the PAGE
  // text colour and go invisible on the light theme.
  color: 'var(--lf-text-primary, #e6e8eb)',
  border: '1px solid var(--lf-border-subtle, #2a3140)',
  borderRadius: 8,
  padding: 16,
  minWidth: 240,
  maxWidth: 520,
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
  color: '#fff',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#7a2a2a',
  borderColor: '#5a1f1f',
  color: '#fff',
};

const disabledStyle: CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };

const inputStyle: CSSProperties = {
  padding: '6px 8px',
  background: 'var(--lf-surface-container, #1c2530)',
  color: 'var(--lf-text-primary, #e6e8eb)',
  border: '1px solid var(--lf-border-subtle, #2a3140)',
  borderRadius: 4,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--lf-text-secondary, #9aa3ad)',
};

const errorStyle: CSSProperties = { color: '#e36049', fontSize: 12, margin: '8px 0 0 0' };

/** Vote counts only — never who voted for what. */
function totalVotes(options: PollOption[]): number {
  return options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0);
}

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
  const t: Translate = (key, params) => tFor(locale, key, params);

  // The host hands us whatever the activity route returned; be
  // defensive about a half-migrated or empty state blob.
  const phase = state?.phase ?? 'idle';
  const options: PollOption[] = Array.isArray(state?.options) ? state.options : [];
  const ballotCount = Number(state?.ballotCount) || 0;
  const hasVoted = state?.hasVoted === true;

  if (phase === 'open' || phase === 'closed') {
    return (
      <LivePollView
        t={t}
        state={state}
        phase={phase}
        options={options}
        ballotCount={ballotCount}
        hasVoted={hasVoted}
        isHost={isHost}
        actorUserId={actorUserId}
        playerCount={Array.isArray(players) ? players.length : 0}
        dispatch={dispatch}
      />
    );
  }
  return <ComposeView t={t} isHost={isHost} actorUserId={actorUserId} dispatch={dispatch} />;
}

/* ------------------------------------------------------------------ */
/* idle — the host composes a poll                                     */
/* ------------------------------------------------------------------ */

function ComposeView({
  t,
  isHost,
  actorUserId,
  dispatch,
}: {
  t: Translate;
  isHost: boolean;
  actorUserId: string;
  dispatch: PollPanelClientProps['dispatch'];
}): ReactNode {
  const [question, setQuestion] = useState('');
  const [drafts, setDrafts] = useState<string[]>(() =>
    Array.from({ length: POLL_MIN_OPTIONS }, () => '')
  );
  const [error, setError] = useState<string | null>(null);

  const filled = drafts.map((d) => d.trim()).filter(Boolean);
  const canAdd = drafts.length < POLL_MAX_OPTIONS;
  const canRemove = drafts.length > POLL_MIN_OPTIONS;
  const canOpen = question.trim().length > 0 && filled.length >= POLL_MIN_OPTIONS;

  const setDraft = (index: number, value: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? value.slice(0, POLL_MAX_OPTION_LENGTH) : d)));
  };

  const openPoll = () => {
    if (question.trim().length === 0) {
      setError(t('poll.error.questionRequired'));
      return;
    }
    if (filled.length < POLL_MIN_OPTIONS) {
      setError(t('poll.error.optionsRequired', { min: POLL_MIN_OPTIONS }));
      return;
    }
    setError(null);
    void dispatch({
      type: 'open-poll',
      hostId: actorUserId,
      question: question.trim(),
      options: filled,
    });
  };

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 16 }}>
        {t('poll.title')} — {t('poll.phase.idle')}
      </h3>
      <p style={{ ...mutedStyle, margin: '0 0 12px 0' }}>{t('poll.tagline')}</p>

      {!isHost ? (
        <p style={{ fontSize: 13, margin: 0 }}>{t('poll.compose.waitingForHost')}</p>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: '0 0 12px 0' }}>{t('poll.compose.hostPrompt')}</p>

          <label style={{ ...labelStyle, marginBottom: 12 }}>
            {t('poll.compose.questionLabel')}
            <input
              value={question}
              maxLength={POLL_MAX_QUESTION_LENGTH}
              placeholder={t('poll.compose.questionPlaceholder')}
              onChange={(e) => setQuestion(e.target.value.slice(0, POLL_MAX_QUESTION_LENGTH))}
              style={inputStyle}
            />
            <span style={{ fontSize: 11, color: 'var(--lf-text-secondary, #9aa3ad)' }}>
              {t('poll.compose.remaining', { count: POLL_MAX_QUESTION_LENGTH - question.length })}
            </span>
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
            {drafts.map((draft, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  {t('poll.compose.optionLabel', { index: index + 1 })}
                  <input
                    value={draft}
                    maxLength={POLL_MAX_OPTION_LENGTH}
                    placeholder={t('poll.compose.optionPlaceholder', { index: index + 1 })}
                    onChange={(e) => setDraft(index, e.target.value)}
                    style={inputStyle}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                  disabled={!canRemove}
                  aria-label={t('poll.compose.removeOption', { index: index + 1 })}
                  title={t('poll.compose.removeOption', { index: index + 1 })}
                  style={{
                    ...baseButtonStyle,
                    padding: '6px 10px',
                    ...(canRemove ? {} : disabledStyle),
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setDrafts((prev) => (prev.length < POLL_MAX_OPTIONS ? [...prev, ''] : prev))}
              disabled={!canAdd}
              style={{ ...baseButtonStyle, ...(canAdd ? {} : disabledStyle) }}
            >
              {t('poll.compose.addOption')}
            </button>
            <span style={{ fontSize: 11, color: 'var(--lf-text-secondary, #9aa3ad)' }}>
              {t('poll.compose.optionLimit', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS })}
            </span>
          </div>

          <button
            type="button"
            onClick={openPoll}
            disabled={!canOpen}
            style={{ ...primaryButtonStyle, ...(canOpen ? {} : disabledStyle) }}
          >
            {t('poll.compose.openButton')}
          </button>

          {error ? (
            <p role="alert" style={errorStyle}>
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* open / closed — voting and results                                  */
/* ------------------------------------------------------------------ */

function LivePollView({
  t,
  state,
  phase,
  options,
  ballotCount,
  hasVoted,
  isHost,
  actorUserId,
  playerCount,
  dispatch,
}: {
  t: Translate;
  state: PollViewState;
  phase: 'open' | 'closed';
  options: PollOption[];
  ballotCount: number;
  hasVoted: boolean;
  isHost: boolean;
  actorUserId: string;
  playerCount: number;
  dispatch: PollPanelClientProps['dispatch'];
}): ReactNode {
  const isOpen = phase === 'open';
  // Once the viewer has cast their ballot there is nothing left to
  // vote on, so the option rows turn into the results read-out.
  const showResults = !isOpen || hasVoted;
  const total = totalVotes(options);
  const leaderId = pollLeader({ options });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <div style={cardStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {state?.question?.trim() ? state.question : t('poll.noQuestion')}
          </h3>
          <span style={{ ...mutedStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
            {isOpen ? t('poll.phase.open') : t('poll.phase.closed')}
          </span>
        </div>

        <p style={{ ...mutedStyle, fontSize: 12, margin: '0 0 12px 0' }}>
          {/*
            `players` is the activity's registered player list, and the
            host only registers the creator today — so it is routinely
            SMALLER than the number of ballots. Showing "3 of 1 players"
            would be worse than no denominator, hence the guard.
          */}
          {playerCount > 1 && ballotCount <= playerCount
            ? t('poll.turnout', { count: ballotCount, total: playerCount })
            : ballotCount === 1
              ? t('poll.turnoutOne')
              : t('poll.turnoutSimple', { count: ballotCount })}
        </p>

        {!isOpen ? (
          <p style={{ ...mutedStyle, fontSize: 12, margin: '0 0 8px 0' }}>{t('poll.closed.title')}</p>
        ) : showResults ? (
          <p style={{ ...mutedStyle, fontSize: 12, margin: '0 0 8px 0' }}>{t('poll.open.voted')}</p>
        ) : (
          <p style={{ ...mutedStyle, fontSize: 12, margin: '0 0 8px 0' }}>{t('poll.open.voteHint')}</p>
        )}

        {options.length === 0 ? (
          <p style={{ ...mutedStyle, margin: 0 }}>{t('poll.results.noVotes')}</p>
        ) : showResults ? (
          <ResultsList t={t} options={options} total={total} leaderId={leaderId} isClosed={!isOpen} />
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  // Visible label is the option text; the accessible
                  // name repeats it verbatim (WCAG 2.5.3).
                  aria-label={t('poll.open.voteFor', { option: option.text })}
                  onClick={() => {
                    void dispatch({ type: 'vote', playerId: actorUserId, optionId: option.id });
                  }}
                  style={{
                    ...baseButtonStyle,
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontSize: 14,
                    background: 'var(--lf-surface-raised, #11151b)',
                  }}
                >
                  {option.text}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!isOpen && total > 0 && leaderId === null ? (
          <p style={{ ...mutedStyle, fontSize: 12, margin: '8px 0 0 0' }}>{t('poll.results.tie')}</p>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {isOpen ? (
          // Kept visible (and disabled) for non-hosts so everyone can
          // see the poll CAN be closed and by whom.
          <button
            type="button"
            disabled={!isHost}
            title={isHost ? undefined : t('poll.hostOnly')}
            onClick={() => {
              void dispatch({ type: 'close-poll', hostId: actorUserId });
            }}
            style={{ ...baseButtonStyle, ...(isHost ? {} : disabledStyle) }}
          >
            {t('poll.open.closeButton')}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={!isHost}
              title={isHost ? undefined : t('poll.hostOnly')}
              onClick={() => {
                void dispatch({ type: 'reopen-poll', hostId: actorUserId });
              }}
              style={{ ...primaryButtonStyle, ...(isHost ? {} : disabledStyle) }}
            >
              {t('poll.closed.reopenButton')}
            </button>
            <button
              type="button"
              disabled={!isHost}
              title={isHost ? undefined : t('poll.hostOnly')}
              onClick={() => {
                void dispatch({ type: 'clear-poll', hostId: actorUserId });
              }}
              style={{ ...dangerButtonStyle, ...(isHost ? {} : disabledStyle) }}
            >
              {t('poll.closed.clearButton')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ResultsList({
  t,
  options,
  total,
  leaderId,
  isClosed,
}: {
  t: Translate;
  options: PollOption[];
  total: number;
  leaderId: string | null;
  isClosed: boolean;
}): ReactNode {
  if (total === 0) {
    return (
      <>
        <p style={{ ...mutedStyle, fontSize: 12, margin: '0 0 8px 0' }}>{t('poll.results.noVotes')}</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {options.map((option) => (
            <li key={option.id} style={{ fontSize: 14, padding: '4px 0' }}>
              {option.text}
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {options.map((option) => {
        const share = Math.round((option.votes / total) * 100);
        const isLeader = option.id === leaderId;
        return (
          <li key={option.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 14,
                marginBottom: 4,
              }}
            >
              <span>
                {option.text}
                {isLeader ? (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: '#2f8f62',
                      color: '#fff',
                      fontSize: 11,
                    }}
                  >
                    {isClosed ? t('poll.results.winner') : t('poll.results.leader')}
                  </span>
                ) : null}
              </span>
              <span style={{ ...mutedStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
                {option.votes === 1
                  ? t('poll.results.votesOne')
                  : t('poll.results.votes', { count: option.votes })}{' '}
                · {t('poll.results.share', { percent: share })}
              </span>
            </div>
            {/* Decorative: every number it encodes is in the text above. */}
            <div
              aria-hidden="true"
              style={{
                height: 8,
                borderRadius: 4,
                background: 'var(--lf-surface-container, #1c2530)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${share}%`,
                  height: '100%',
                  background: isLeader ? '#2f8f62' : 'var(--lf-border-subtle, #2a3140)',
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
