'use client';

/**
 * The lobby's join-request buttons, shown by the server-rendered
 * "community unavailable" page when the community reviews newcomers:
 *   - `ask`: an optional note and "Ask to join" →
 *     POST /api/servers/{id}/join-requests/mine. The page load never files
 *     a request; only this explicit, same-origin click does.
 *   - `pending`: "Withdraw request" → DELETE …/mine.
 * After a change the server component is re-rendered (`router.refresh()`),
 * so the page always shows what the server knows: waiting, declined,
 * banned, or the community itself once the user is in.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/client';

/** Same limit as the API (JOIN_REQUEST_NOTE_MAX_LENGTH). */
const NOTE_MAX_LENGTH = 500;

/** Answers after which the server-rendered page already says the right thing. */
const REFRESH_CODES = new Set(['join_rejected', 'banned', 'already_member', 'approval_not_required']);

export function LobbyJoinRequestActions({ serverId, mode }: { serverId: string; mode: 'ask' | 'pending' }) {
  const t = useT();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/servers/${encodeURIComponent(serverId)}/join-requests/mine`;

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        ...(trimmed
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: trimmed }) }
          : {}),
      });
      if (res.ok) {
        // 202: the page now shows "waiting" (the buttons stay busy until it does).
        router.refresh();
        return;
      }
      const detail = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.status === 429) {
        setError(t('lobby.unavailable.requestLimit'));
      } else if (detail.code && REFRESH_CODES.has(detail.code)) {
        router.refresh();
        return;
      } else {
        setError(t('lobby.unavailable.requestFailed'));
      }
    } catch {
      setError(t('lobby.unavailable.requestFailed'));
    }
    setBusy(false);
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(t('lobby.unavailable.withdrawFailed'));
    } catch {
      setError(t('lobby.unavailable.withdrawFailed'));
    }
    setBusy(false);
  }

  const errorText = error ? (
    <p id={errorId} role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;

  if (mode === 'pending') {
    return (
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={withdraw}
          disabled={busy}
          aria-describedby={error ? errorId : undefined}
          className="inline-flex items-center gap-2 rounded-md border border-danger/40 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            undo
          </span>
          {t('lobby.unavailable.withdrawRequest')}
        </button>
        {errorText}
      </div>
    );
  }

  return (
    <form onSubmit={ask} className="mt-5 space-y-3 text-left" aria-busy={busy}>
      <div>
        <label htmlFor={noteId} className="block text-sm font-medium text-text-primary">
          {t('lobby.unavailable.noteLabel')}
        </label>
        <textarea
          id={noteId}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          disabled={busy}
          placeholder={t('lobby.unavailable.notePlaceholder')}
          className="mt-1 w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        aria-describedby={error ? errorId : undefined}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-lg" aria-hidden>
          send
        </span>
        {t('lobby.unavailable.askToJoin')}
      </button>
      {errorText}
    </form>
  );
}
