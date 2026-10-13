'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BannerIconButton } from './ProfileParts';

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

type ItemElement = HTMLButtonElement | HTMLAnchorElement;
const isEnabled = (item: ItemElement | null): item is ItemElement =>
  Boolean(item && !(item instanceof HTMLButtonElement && item.disabled));

export interface ProfileMenuItem {
  id: string;
  label: string;
  icon: string;
  /** A link item (e.g. Edit profile) instead of an action. */
  href?: string;
  onSelect?: () => void;
  tone?: 'danger';
  disabled?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
}

/**
 * The profile's "⋯" menu. Opening it focuses the first item; arrow keys,
 * Home and End move; Escape closes it and returns focus to the button
 * (without closing the profile); Tab or a click elsewhere closes it.
 */
export function ProfileMenu({ label, items }: { label: string; items: ProfileMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<ItemElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current.find(isEnabled)?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (items.length === 0) return null;

  const move = (delta: number | 'first' | 'last') => {
    const enabled = itemRefs.current.filter(isEnabled);
    if (enabled.length === 0) return;
    const index = enabled.indexOf(document.activeElement as ItemElement);
    const next =
      delta === 'first' ? 0 : delta === 'last' ? enabled.length - 1 : (index + delta + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <BannerIconButton
        buttonRef={triggerRef}
        icon="more_horiz"
        label={label}
        hasPopup="menu"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-20 mt-1.5 w-56 rounded-lg border border-border-subtle bg-surface-floating p-1 shadow-xl"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              move('first');
            } else if (event.key === 'End') {
              event.preventDefault();
              move('last');
            } else if (event.key === 'Escape') {
              // Closes the menu only — the profile stays open.
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (event.key === 'Tab') {
              setOpen(false);
            }
          }}
        >
          {items.map((item, index) => (
            <div key={item.id} role="none">
              {item.separated ? <div className="my-1 h-px bg-border-subtle" role="separator" /> : null}
              {item.href ? (
                <Link
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                  className={`${ITEM_CLASS} text-text-primary hover:bg-surface-container-high focus:bg-surface-container-high`}
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden>{item.icon}</span>
                  {item.label}
                </Link>
              ) : (
                <button
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                    item.onSelect?.();
                  }}
                  className={`${ITEM_CLASS} ${
                    item.tone === 'danger'
                      ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
                      : 'text-text-primary hover:bg-surface-container-high focus:bg-surface-container-high'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden>{item.icon}</span>
                  {item.label}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
