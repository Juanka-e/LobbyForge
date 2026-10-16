'use client';

import { useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type MutableRefObject } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';

/**
 * @mention autocomplete dropdown for the lobby message composer.
 *
 * When the user types @ followed by at least one character, this
 * component fetches the server's member list and shows a filtered
 * dropdown. Selecting a member inserts @displayName into the input
 * and reports the userId and that name (`onMention`): the composer sends
 * the picks with the post, and the server stores them as the message's
 * mentions (docs/PROFILES.md "Mentions"). A member matches on their name
 * or their handle.
 */

/** Case folding for matching: the viewer's locale (Turkish İ/I), accents kept. */
function fold(text: string, locale: string): string {
  return text.normalize('NFC').toLocaleLowerCase(locale).replace(/\u0307/g, '');
}

export interface MentionUser {
  userId: string;
  displayName: string;
  /** The handle (0050), matched and shown as `@name`. */
  username?: string | null;
  roleName?: string | null;
  roleColor?: string | null;
  avatarUrl?: string | null;
}

export interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  members: MentionUser[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** A member was picked: their id and the name inserted after `@`. */
  onMention?: (userId: string, label: string) => void;
  /**
   * Runs before the mention keys; return true when the key was handled
   * (the composer's slash command picker owns the arrows while it is open).
   */
  onBeforeKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => boolean;
  /** Extra attributes for the input — e.g. the combobox role and its ARIA state. */
  inputProps?: InputHTMLAttributes<HTMLInputElement> & { [data: `data-${string}`]: string | boolean | undefined };
  /** Receives the input element, for callers that move focus back to it. */
  inputRef?: MutableRefObject<HTMLInputElement | null>;
}

export function MentionInput({
  value,
  onChange,
  members,
  placeholder,
  disabled,
  className,
  onMention,
  onBeforeKeyDown,
  inputProps,
  inputRef: externalRef,
}: MentionInputProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Where the caret goes once the value with a picked mention is in the input. */
  const pendingCaret = useRef<number | null>(null);

  // Right after the new value is committed, before the next key is read: a
  // caret placed a frame later (as it was) jumped back over what the user
  // had typed meanwhile — "@Ivy Novak and" came out as "@Ivy Novak nd…a".
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const input = inputRef.current;
    if (caret === null || !input) return;
    pendingCaret.current = null;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [value]);

  // Detect @mention trigger: find the last @ before the cursor and
  // check if the text after it (up to cursor) is a valid search string
  // (no spaces, length >= 1).
  function detectMention(text: string, cursorPos: number) {
    const beforeCursor = text.substring(0, cursorPos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx < 0) {
      setMentionQuery(null);
      return;
    }
    // Check @ is at start or preceded by whitespace
    if (atIdx > 0 && !/\s/.test(beforeCursor[atIdx - 1])) {
      setMentionQuery(null);
      return;
    }
    const query = beforeCursor.substring(atIdx + 1);
    // If the query contains a space, the mention attempt is over
    if (/\s/.test(query) || query.length === 0) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(fold(query, t.locale));
    setMentionIndex(0);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newVal = e.target.value;
    onChange(newVal);
    detectMention(newVal, e.target.selectionStart ?? newVal.length);
  }

  const filtered = mentionQuery !== null
    ? members
        .filter(
          (m) =>
            fold(m.displayName, t.locale).includes(mentionQuery) ||
            Boolean(m.username && m.username.startsWith(mentionQuery))
        )
        .slice(0, 8)
    : [];

  function selectMention(user: MentionUser) {
    if (!inputRef.current) return;
    const text = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? text.length;
    const beforeCursor = text.substring(0, cursorPos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx < 0) return;
    const afterCursor = text.substring(cursorPos);
    const insertion = `@${user.displayName} `;
    const newValue = text.substring(0, atIdx) + insertion + afterCursor;
    pendingCaret.current = atIdx + insertion.length;
    onChange(newValue);
    setMentionQuery(null);
    onMention?.(user.userId, user.displayName);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (onBeforeKeyDown?.(e)) return;
    if (mentionQuery !== null && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % filtered.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filtered[Math.min(mentionIndex, filtered.length - 1)];
        if (selected) selectMention(selected);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    // When mention dropdown is closed, let Enter propagate to the form
    // (natural submit behavior). Do NOT preventDefault here.
  }

  return (
    <div className="relative flex-1">
      <input
        {...inputProps}
        ref={(el) => {
          inputRef.current = el;
          if (externalRef) externalRef.current = el;
        }}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setMentionQuery(null), 150)}
        disabled={disabled}
        className={className ?? 'flex-1 bg-transparent border-none focus:ring-0 text-body-md text-text-primary placeholder:text-text-muted py-2 outline-none'}
        placeholder={placeholder}
        type="text"
      />
      {mentionQuery !== null && filtered.length > 0 ? (
        <div className="absolute bottom-full left-0 mb-2 w-64 max-h-64 overflow-y-auto rounded-lg border border-border-subtle bg-surface-raised shadow-2xl z-50">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-b border-border-subtle">
            {t('lobbyMain.composer.mentionMatches', { query: mentionQuery })}
          </div>
          {/* A list of choices to screen readers too: the arrow keys move the
              selection from the input, so the options never take focus. */}
          <ul role="listbox" aria-label={t('lobbyMain.composer.mentionMatches', { query: mentionQuery })}>
            {filtered.map((user, idx) => (
              <li key={user.userId} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === mentionIndex}
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(user);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    idx === mentionIndex ? 'bg-primary/10' : 'hover:bg-surface-container'
                  }`}
                >
                  <div className="w-7 h-7 rounded-full bg-secondary-container flex items-center justify-center font-bold text-text-primary text-xs flex-shrink-0 overflow-hidden">
                    {user.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- same-origin avatar route
                      <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      initialOf(user.displayName, { locale: t.locale })
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className="text-sm font-medium text-text-primary truncate block"
                      style={user.roleColor ? { color: user.roleColor } : undefined}
                    >
                      {user.displayName}
                    </span>
                    {user.username || user.roleName ? (
                      <span className="text-[10px] text-text-muted truncate block">
                        {[user.username ? `@${user.username}` : null, user.roleName].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
