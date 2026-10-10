'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { handleEmailUnverified, requestVerificationFocus } from '@/components/email-verification/email-status-store';
import {
  asChatPollView,
  isChatPollClosed,
  pollSharePercent,
  pollTimeLeft,
  type ChatPollView,
} from '@/lib/chat-polls';

/**
 * A poll posted in a text channel (docs/CHAT_POLLS.md), inside its message
 * row. Before the viewer votes on an open poll: the options as a radio
 * group (or checkboxes when several answers are allowed) and the number of
 * voters, no counts. After voting, or once the poll has closed: bars with
 * the share and the count of each option, the viewer's own choice marked.
 * The voter total is announced politely when it changes; the clock is not.
 */

const TICK_MS = 30_000;
/** A poll this browser's clock thinks has closed may still be open on the server: ask again. */
const FINAL_RESULTS_RETRY_MS = 5_000;
const FINAL_RESULTS_MAX_TRIES = 6;

type FocusTarget = 'results' | 'form' | 'confirm' | 'closeTrigger' | null;

function timeLeftText(t: Translator, closesAt: string, closed: boolean, now: Date): string {
  const left = pollTimeLeft(closesAt, closed, now);
  switch (left.unit) {
    case 'closed':
      return t('lobbyMain.poll.closed');
    case 'lessThanMinute':
      return t('lobbyMain.poll.closesSoon');
    case 'minutes':
      return t('lobbyMain.poll.closesInMinutes', { count: left.count });
    case 'hours':
      return t('lobbyMain.poll.closesInHours', { count: left.count });
    case 'days':
      return t('lobbyMain.poll.closesInDays', { count: left.count });
  }
}

export interface ChatPollCardProps {
  poll: ChatPollView;
  serverId: string;
  channelId: string;
  /** The poll's creator or a member with Manage Messages. */
  canClose: boolean;
  /** A new view of the poll (after a vote, a close, or a refetch). */
  onChange: (poll: ChatPollView) => void;
}

export function ChatPollCard({ poll, serverId, channelId, canClose, onChange }: ChatPollCardProps) {
  const t = useT();
  const questionId = useId();
  const hintId = useId();
  const [now, setNow] = useState(() => new Date());
  const [selection, setSelection] = useState<number[]>(poll.myChoices);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [finalTry, setFinalTry] = useState(0);
  const pendingFocus = useRef<FocusTarget>(null);
  const resultsRef = useRef<HTMLUListElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The parent passes a new callback on every render; the refetch timer must not restart with it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const closed = poll.closed || isChatPollClosed(poll, now);
  const hasVoted = poll.myChoices.length > 0;
  const showResults = closed || (hasVoted && !changing);
  const countsMissing = poll.options.some((option) => option.votes === null);
  const base = `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/polls/${encodeURIComponent(poll.id)}`;

  // The clock only moves the "Closes in …" text; nothing is announced.
  useEffect(() => {
    if (closed) return;
    const id = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(id);
  }, [closed]);

  // Closed (by this browser's clock, or by a refusal) while this viewer had
  // never received counts: fetch the final results. The server's clock
  // decides — if it still calls the poll open, ask again a little later.
  useEffect(() => {
    if (!closed || !countsMissing || finalTry >= FINAL_RESULTS_MAX_TRIES) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        void fetch(base, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (res) => (res.ok ? asChatPollView(((await res.json()) as { poll?: unknown }).poll) : null))
          .then((next) => {
            if (cancelled) return;
            if (next?.resultsVisible) onChangeRef.current(next);
            else setFinalTry((n) => n + 1);
          })
          .catch(() => {
            if (!cancelled) setFinalTry((n) => n + 1);
          });
      },
      finalTry === 0 ? 0 : FINAL_RESULTS_RETRY_MS
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, closed, countsMissing, finalTry]);

  // Keyboard focus follows the action that replaced the control it was on.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === 'results') resultsRef.current?.focus();
    else if (target === 'confirm') confirmRef.current?.focus();
    else if (target === 'closeTrigger') closeTriggerRef.current?.focus();
    else if (target === 'form') {
      const inputs = formRef.current?.querySelectorAll<HTMLInputElement>('input');
      const checked = Array.from(inputs ?? []).find((input) => input.checked);
      (checked ?? inputs?.[0])?.focus();
    }
  });

  async function send(path: string, method: 'PUT' | 'DELETE' | 'POST', body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as { poll?: unknown; code?: string } | null;
      if (handleEmailUnverified(res.status, payload)) {
        requestVerificationFocus();
        return;
      }
      if (!res.ok) {
        setError(payload?.code === 'poll_closed' ? t('lobbyMain.poll.error.closed') : t('lobbyMain.poll.error.generic'));
        if (payload?.code === 'poll_closed') {
          pendingFocus.current = 'results';
          onChange({ ...poll, closed: true });
        }
        return;
      }
      const next = asChatPollView(payload?.poll);
      if (next) {
        // After a vote or a close the results replace the control; after a
        // removal the choices come back.
        pendingFocus.current = next.myChoices.length > 0 || next.closed ? 'results' : 'form';
        onChange(next);
        setSelection(next.myChoices);
        setChanging(false);
        setConfirmClose(false);
      }
    } catch {
      setError(t('lobbyMain.poll.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  function submitVote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selection.length === 0 || busy) return;
    void send(`${base}/vote`, 'PUT', { choices: [...selection].sort((a, b) => a - b) });
  }

  function toggle(index: number, checked: boolean) {
    if (poll.allowMultiple) {
      setSelection((current) => (checked ? [...new Set([...current, index])] : current.filter((i) => i !== index)));
    } else if (checked) {
      setSelection([index]);
    }
  }

  const totalVotes = poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
  const votersText = t('lobbyMain.poll.voters', { count: poll.totalVoters });

  return (
    <section
      data-chat-poll={poll.id}
      data-poll-closed={closed ? 'true' : undefined}
      aria-labelledby={questionId}
      className="mt-2 w-full max-w-md rounded-xl border border-border-subtle bg-surface-container-low p-3 sm:p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-label-xs text-[11px] font-medium uppercase tracking-wider text-text-muted">
          <span className="material-symbols-outlined text-[16px]" aria-hidden>ballot</span>
          {t('lobbyMain.poll.label')}
        </span>
        <span
          className={
            closed
              ? 'rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-medium text-text-secondary'
              : 'text-[11px] text-text-secondary'
          }
          data-poll-status
        >
          {timeLeftText(t, poll.closesAt, closed, now)}
        </span>
      </header>

      <p id={questionId} className="mt-2 font-body-md font-semibold text-text-primary break-words">
        {poll.question}
      </p>

      {showResults ? (
        <ul
          ref={resultsRef}
          tabIndex={-1}
          className="mt-3 space-y-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('lobbyMain.poll.resultsLabel')}
          aria-busy={countsMissing ? true : undefined}
        >
          {poll.options.map((option, index) => {
            const mine = poll.myChoices.includes(index);
            // Never a fake 0 %: until the final counts arrive, the answer stands alone.
            const known = option.votes !== null;
            const votes = option.votes ?? 0;
            const percent = pollSharePercent(votes, totalVotes);
            return (
              <li
                key={index}
                data-poll-option={index}
                data-poll-mine={mine ? 'true' : undefined}
                className={`relative overflow-hidden rounded-lg border px-3 py-2 ${mine ? 'border-primary' : 'border-border-subtle'}`}
              >
                {known ? (
                  <span
                    aria-hidden
                    className={`absolute inset-y-0 left-0 ${mine ? 'bg-primary/25' : 'bg-primary/10'}`}
                    style={{ width: `${percent}%` }}
                  />
                ) : null}
                <span className="relative flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words text-sm text-text-primary">
                    {mine ? (
                      <span className="material-symbols-outlined mr-1 align-[-3px] text-[16px] text-primary" aria-hidden>
                        check_circle
                      </span>
                    ) : null}
                    {option.text}
                    {mine ? <span className="ml-2 text-[11px] font-medium text-primary">{t('lobbyMain.poll.yourVote')}</span> : null}
                  </span>
                  {known ? (
                    <span className="shrink-0 text-right text-xs tabular-nums text-text-secondary">
                      <span className="font-semibold text-text-primary">{t('lobbyMain.poll.share', { percent })}</span>
                      <span className="block">{t('lobbyMain.poll.optionVotes', { count: votes })}</span>
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <form ref={formRef} onSubmit={submitVote} className="mt-3">
          <fieldset aria-labelledby={questionId} aria-describedby={hintId} disabled={busy}>
            <p id={hintId} className="mb-2 text-xs text-text-muted">
              {poll.allowMultiple ? t('lobbyMain.poll.pickMany') : t('lobbyMain.poll.pickOne')}
              {' · '}
              {t('lobbyMain.poll.hiddenUntilVote')}
            </p>
            <div className="space-y-2">
              {poll.options.map((option, index) => {
                const checked = selection.includes(index);
                return (
                  <label
                    key={index}
                    data-poll-option={index}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm text-text-primary transition-colors focus-within:ring-2 focus-within:ring-primary ${
                      checked ? 'border-primary bg-primary/10' : 'border-border-subtle hover:bg-surface-container'
                    }`}
                  >
                    <input
                      type={poll.allowMultiple ? 'checkbox' : 'radio'}
                      name={`poll-${poll.id}`}
                      value={index}
                      checked={checked}
                      onChange={(event) => toggle(index, event.target.checked)}
                      className="mt-0.5 size-4 shrink-0 border-border-strong bg-surface text-primary focus:ring-primary"
                    />
                    <span className="min-w-0 break-words">{option.text}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={selection.length === 0 || busy}
              className="rounded-md bg-primary-container px-3 py-1.5 text-sm font-medium text-on-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t('lobbyMain.poll.sending') : t('lobbyMain.poll.submitVote')}
            </button>
            {changing ? (
              <button
                type="button"
                onClick={() => {
                  pendingFocus.current = 'results';
                  setChanging(false);
                  setSelection(poll.myChoices);
                }}
                className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                {t('lobbyMain.chat.cancel')}
              </button>
            ) : null}
          </div>
        </form>
      )}

      {showResults && countsMissing ? (
        <p className="mt-2 text-xs text-text-muted" role="status">
          {t('lobbyMain.poll.loadingResults')}
        </p>
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>
          <span aria-live="polite" data-poll-voters>
            {votersText}
          </span>
          <span aria-hidden> · </span>
          <span>{t('lobbyMain.poll.anonymous')}</span>
        </span>
        {!closed && (hasVoted || canClose) ? (
          <span className="flex flex-wrap items-center gap-1">
            {hasVoted && !changing ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    pendingFocus.current = 'form';
                    setSelection(poll.myChoices);
                    setChanging(true);
                  }}
                  className="rounded px-2 py-1 font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary disabled:opacity-40"
                >
                  {t('lobbyMain.poll.changeVote')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send(`${base}/vote`, 'DELETE')}
                  className="rounded px-2 py-1 font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary disabled:opacity-40"
                >
                  {t('lobbyMain.poll.removeVote')}
                </button>
              </>
            ) : null}
            {canClose && !confirmClose ? (
              <button
                ref={closeTriggerRef}
                type="button"
                disabled={busy}
                onClick={() => {
                  pendingFocus.current = 'confirm';
                  setConfirmClose(true);
                }}
                className="rounded px-2 py-1 font-medium text-text-secondary hover:bg-surface-container hover:text-danger disabled:opacity-40"
              >
                {t('lobbyMain.poll.close')}
              </button>
            ) : null}
          </span>
        ) : null}
      </footer>

      {confirmClose && !closed ? (
        <div role="group" aria-label={t('lobbyMain.poll.close')} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-container px-3 py-2 text-xs text-text-secondary">
          <span className="min-w-0 flex-1">{t('lobbyMain.poll.closeConfirm')}</span>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={() => void send(`${base}/close`, 'POST')}
            className="rounded-md bg-danger px-2.5 py-1 font-medium text-on-primary-container disabled:opacity-40"
          >
            {t('lobbyMain.poll.closeNow')}
          </button>
          <button
            type="button"
            onClick={() => {
              pendingFocus.current = 'closeTrigger';
              setConfirmClose(false);
            }}
            className="rounded-md px-2.5 py-1 text-text-secondary hover:text-text-primary"
          >
            {t('lobbyMain.chat.cancel')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
