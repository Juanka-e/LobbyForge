'use client';

import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';

/**
 * A small searchable picker (combobox + listbox) for long lists — the
 * `user` option's member picker, fed by the same member list as @mentions.
 * Type to filter, arrows to move, Enter to pick, Escape to close the list
 * (a second Escape reaches the form and cancels the command).
 */

export interface SearchSelectItem {
  id: string;
  label: string;
  sublabel?: string | null;
  avatarUrl?: string | null;
  color?: string | null;
}

const MAX_RESULTS = 8;

export function SearchSelect({
  id,
  items,
  value,
  onChange,
  placeholder,
  invalid,
  describedBy,
  inputRef,
  noResults,
}: {
  id: string;
  items: SearchSelectItem[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  noResults: string;
}) {
  const t = useT();
  const listboxId = useId();
  const selected = items.find((item) => item.id === value) ?? null;
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const text = query ?? selected?.label ?? '';
  const needle = (query ?? '').trim().toLocaleLowerCase();
  const results = (needle ? items.filter((item) => item.label.toLocaleLowerCase().includes(needle)) : items).slice(
    0,
    MAX_RESULTS
  );
  const active = open ? results[Math.min(activeIndex, results.length - 1)] ?? null : null;

  function pick(item: SearchSelectItem) {
    onChange(item.id);
    setQuery(null);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (results.length) setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open && results.length) setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && open && active) {
      event.preventDefault();
      pick(active);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery(null);
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
          if (value) onChange(undefined);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery(null);
        }}
        onKeyDown={onKeyDown}
        className={`w-full rounded-md border bg-surface-raised px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary ${
          invalid ? 'border-danger' : 'border-border-strong focus:border-primary'
        }`}
      />
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border-subtle bg-surface-raised py-1 shadow-2xl"
        >
          {results.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-muted">{noResults}</div>
          ) : (
            results.map((item) => (
              <div
                key={item.id}
                id={`${listboxId}-${item.id}`}
                role="option"
                aria-selected={item.id === active?.id}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                  item.id === active?.id ? 'bg-primary/10' : 'hover:bg-surface-container'
                }`}
              >
                <span className="grid size-6 flex-none place-items-center overflow-hidden rounded-full bg-secondary-container text-[11px] font-bold text-text-primary">
                  {item.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- small same-origin avatar, like the mention list
                    <img src={item.avatarUrl} alt="" className="size-full object-cover" />
                  ) : (
                    initialOf(item.label, { locale: t.locale })
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary" style={item.color ? { color: item.color } : undefined}>
                    {item.label}
                  </span>
                  {item.sublabel ? <span className="block truncate text-[10px] text-text-muted">{item.sublabel}</span> : null}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
