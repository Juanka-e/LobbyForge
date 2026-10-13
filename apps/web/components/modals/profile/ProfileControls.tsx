'use client';

import { useId, useState, type FormEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import {
  PRESENCE_DOT_CLASS,
  PRESENCE_LABEL_KEYS,
  PRESENCE_STATUSES,
  type PresenceStatus,
} from '@/lib/presence-status';

/** The longest DM the DM route accepts. */
const DM_MAX_LENGTH = 4000;

/**
 * "Message @name": type and press Enter — the DM is opened (or created)
 * and the message sent there; the caller then shows the conversation.
 * A refusal keeps the draft and is said under the box.
 */
export function MessageBox({
  name,
  onSend,
}: {
  name: string;
  /** Resolves to an error to show, or null when the message went out. */
  onSend: (text: string) => Promise<string | null>;
}) {
  const t = useT();
  const errorId = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onSend(text);
    setBusy(false);
    if (failure) setError(failure);
    else setDraft('');
  }

  const label = t('shell.profile.messagePlaceholder', { name });
  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-container px-3 transition-colors focus-within:border-primary">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={label}
          aria-label={label}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          maxLength={DM_MAX_LENGTH}
          enterKeyHint="send"
          disabled={busy}
          className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-0 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          aria-label={t('shell.profile.sendMessage')}
          title={t('shell.profile.sendMessage')}
          className="grid size-7 flex-none place-items-center rounded-md text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:text-text-muted disabled:hover:bg-transparent"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden>{busy ? 'hourglass_top' : 'send'}</span>
        </button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Your own card: the four statuses, the same choice as the account menu's picker. */
export function SelfStatusPicker({
  status,
  onChange,
  sectionId,
}: {
  status: PresenceStatus;
  onChange: (status: PresenceStatus) => void;
  sectionId: string;
}) {
  const t = useT();
  const headingId = `${sectionId}-status`;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
        {t('shell.profile.setStatus')}
      </h3>
      <div role="radiogroup" aria-labelledby={headingId} className="grid grid-cols-2 gap-1">
        {PRESENCE_STATUSES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === status}
            onClick={() => onChange(option)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
              option === status ? 'bg-surface-container-high text-text-primary' : 'text-text-secondary hover:bg-surface-container-high'
            }`}
          >
            <span className={`size-2.5 flex-none rounded-full ${PRESENCE_DOT_CLASS[option]}`} aria-hidden />
            <span className="truncate">{t(PRESENCE_LABEL_KEYS[option])}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The per-user volume slider (only while the member is in voice). */
export function VolumeControl({
  name,
  volume,
  onChange,
}: {
  name: string;
  /** 0..1 */
  volume: number;
  onChange: (volume: number) => void;
}) {
  const t = useT();
  return (
    <section className="border-t border-border-subtle pt-3">
      <div className="mb-2 flex items-center justify-between text-sm text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[17px]" aria-hidden>{volume === 0 ? 'volume_off' : 'volume_up'}</span>
          {t('shell.profile.volume')}
        </span>
        <output>{Math.round(volume * 100)}%</output>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="h-1.5 w-full accent-primary"
        aria-label={t('shell.profile.volumeFor', { name })}
      />
    </section>
  );
}
