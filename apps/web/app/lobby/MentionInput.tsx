'use client';

import { useRef, useState } from 'react';

/**
 * @mention autocomplete dropdown for the lobby message composer.
 *
 * When the user types @ followed by at least one character, this
 * component fetches the server's member list and shows a filtered
 * dropdown. Selecting a member inserts @displayName into the input
 * and stores the userId for mention metadata.
 */

export interface MentionUser {
  userId: string;
  displayName: string;
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
  onMention?: (userId: string) => void;
}

export function MentionInput({
  value,
  onChange,
  members,
  placeholder,
  disabled,
  className,
  onMention,
}: MentionInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

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
    setMentionQuery(query.toLowerCase());
    setMentionIndex(0);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newVal = e.target.value;
    onChange(newVal);
    detectMention(newVal, e.target.selectionStart ?? newVal.length);
  }

  const filtered = mentionQuery !== null
    ? members
        .filter((m) => m.displayName.toLowerCase().includes(mentionQuery))
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
    onChange(newValue);
    setMentionQuery(null);
    onMention?.(user.userId);
    // Focus back and place cursor after the mention
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const newCursor = atIdx + insertion.length;
      inputRef.current?.setSelectionRange(newCursor, newCursor);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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
        ref={inputRef}
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
            Members matching @{mentionQuery}
          </div>
          <ul>
            {filtered.map((user, idx) => (
              <li key={user.userId}>
                <button
                  type="button"
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
                      <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      user.displayName.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className="text-sm font-medium text-text-primary truncate block"
                      style={user.roleColor ? { color: user.roleColor } : undefined}
                    >
                      {user.displayName}
                    </span>
                    {user.roleName ? (
                      <span className="text-[10px] text-text-muted truncate block">{user.roleName}</span>
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
