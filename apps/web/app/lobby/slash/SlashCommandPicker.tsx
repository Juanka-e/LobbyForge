'use client';

import { useEffect, useRef } from 'react';
import { useT } from '@/lib/i18n/client';
import { groupCommandsByBot, type ChannelCommand } from '@/lib/bots/command-options';
import { BotBadge } from '../BotIdentity';

/**
 * The listbox under a composer that starts with `/` (BOT_API_V2 §7):
 * commands grouped by bot, each group headed by the bot's name and the BOT
 * badge. Focus stays in the composer input (a combobox); the input owns
 * the keyboard and points at the active option with
 * `aria-activedescendant` — this component only renders.
 */

export function commandOptionId(listboxId: string, command: ChannelCommand): string {
  return `${listboxId}-${command.id}`;
}

export function SlashCommandPicker({
  listboxId,
  commands,
  activeId,
  status,
  query,
  onSelect,
  onHover,
  onRetry,
}: {
  listboxId: string;
  /** Already filtered and in display order. */
  commands: ChannelCommand[];
  activeId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  query: string;
  onSelect: (command: ChannelCommand) => void;
  onHover: (command: ChannelCommand) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement | null>(null);
  const groups = groupCommandsByBot(commands);

  // Keep the active option in view while arrowing through a long list.
  useEffect(() => {
    if (!activeId) return;
    const options = listRef.current?.querySelectorAll<HTMLElement>('[data-command-id]') ?? [];
    const el = Array.from(options).find((option) => option.dataset.commandId === activeId);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  let empty: string | null = null;
  if (status === 'loading' || status === 'idle') empty = t('interactions.picker.loading');
  else if (status === 'error') empty = t('interactions.picker.error');
  else if (commands.length === 0) empty = query ? t('interactions.picker.noMatch', { query }) : t('interactions.picker.none');

  return (
    <div
      data-slash-picker
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-y-auto rounded-lg border border-border-subtle bg-surface-raised shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5 text-[11px] text-text-muted">
        <span>{t('interactions.picker.title')}</span>
        <span className="hidden sm:inline">{t('interactions.picker.keys')}</span>
      </div>
      <div ref={listRef} id={listboxId} role="listbox" aria-label={t('interactions.picker.label')}>
        {groups.map((group) => {
          const headerId = `${listboxId}-bot-${group.bot.id}`;
          return (
            <div key={group.bot.id} role="group" aria-labelledby={headerId} className="py-1">
              <div id={headerId} className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-xs font-semibold text-text-secondary">
                <span className="truncate">{group.bot.name || t('lobbyMain.chat.unknownBot')}</span>
                <BotBadge />
              </div>
              {group.commands.map((command) => {
                const active = command.id === activeId;
                return (
                  <div
                    key={command.id}
                    id={commandOptionId(listboxId, command)}
                    data-command-id={command.id}
                    role="option"
                    aria-selected={active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelect(command);
                    }}
                    onMouseMove={() => {
                      if (!active) onHover(command);
                    }}
                    className={`flex cursor-pointer flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3 ${
                      active ? 'bg-primary/10' : 'hover:bg-surface-container'
                    }`}
                  >
                    <span className="font-mono text-sm font-medium text-text-primary">/{command.name}</span>
                    <span className="min-w-0 truncate text-xs text-text-secondary">{command.description}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {empty ? (
        <div className="flex items-center justify-between gap-2 px-3 py-3 text-sm text-text-muted" role="status">
          <span>{empty}</span>
          {status === 'error' ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRetry}
              className="rounded border border-border-strong px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-container hover:text-text-primary"
            >
              {t('interactions.picker.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
