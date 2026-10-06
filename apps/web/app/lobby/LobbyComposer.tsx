'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import { moderationBlockedMessageKey } from '@/lib/bots/catalog';
import { commandsInDisplayOrder, filterCommands, type ChannelCommand } from '@/lib/bots/command-options';
import { interactionStore } from '@/lib/bots/interaction-store';
import type { InvokedInteraction } from '@/lib/bots/client-api';
import { MentionInput, type MentionUser } from './MentionInput';
import { SlashCommandPicker, commandOptionId } from './slash/SlashCommandPicker';
import { SlashCommandForm, type ComposerChannel } from './slash/SlashCommandForm';
import { useChannelCommands } from './slash/useChannelCommands';
import EmailUnverifiedNotice, {
  handleEmailUnverified,
  useEmailRestriction,
} from '@/components/email-verification/EmailUnverifiedNotice';

/**
 * The lobby's message composer. Plain text posts to the channel; typing
 * `/` at the start opens the slash command picker (BOT_API_V2 §7): a
 * combobox over the commands this member may run here, grouped by bot.
 * Picking one swaps the input for that command's option fields; running
 * it calls the invoke route and leaves a pending row ("<bot> is
 * thinking…") that only this member sees.
 */

const SLASH_QUERY = /^\/(\S*)$/;

export function LobbyComposer({
  channelName,
  serverId,
  channelId,
  live,
  members,
  channels = [],
}: {
  channelName: string;
  serverId: string | null;
  channelId: string | null;
  live: boolean;
  members: MentionUser[];
  /** Channels the member can see — the `channel` option's choices. */
  channels?: ComposerChannel[];
}) {
  const t = useT();
  const listboxId = useId();
  const hintId = useId();
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The picked command belongs to the channel it was picked in: switching
  // channels drops it (the text draft stays, as before).
  const [picked, setPicked] = useState<{ channelId: string | null; command: ChannelCommand } | null>(null);
  const command = picked && picked.channelId === channelId ? picked.command : null;
  if (picked && picked.channelId !== channelId) setPicked(null);
  const lastTypingRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // EMAIL.md §4.2: a restricted account reads but does not post. Only a
  // live channel asks (the demo lobby has no account behind it).
  const emailLock = useEmailRestriction({ enabled: live });

  const canRunCommands = live && Boolean(serverId && channelId);
  const slashMatch = canRunCommands && !command ? SLASH_QUERY.exec(value) : null;
  const query = slashMatch ? (slashMatch[1] ?? '') : null;
  const commandsState = useChannelCommands(serverId, channelId, query !== null);
  const pickerOpen = query !== null && focused && !pickerDismissed;
  const visible = pickerOpen ? commandsInDisplayOrder(filterCommands(commandsState.commands, query ?? '')) : [];
  const active = visible.find((c) => c.id === activeId) ?? visible[0] ?? null;

  function focusInput() {
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Typing indicator: send a heartbeat every 3s while the user types.
  function handleTyping() {
    if (!live || !serverId || !channelId) return;
    const now = Date.now();
    if (now - lastTypingRef.current < 3000) return;
    lastTypingRef.current = now;
    void fetch(`/api/servers/${serverId}/channels/${channelId}/typing`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => {});
  }

  function pick(next: ChannelCommand) {
    setPicked({ channelId, command: next });
    setValue('');
    setStatus(null);
    setActiveId(null);
  }

  function cancelCommand() {
    setPicked(null);
    setPickerDismissed(false);
    focusInput();
  }

  function onInvoked(interaction: InvokedInteraction) {
    if (!command || !serverId || !channelId) return;
    interactionStore.addPending({
      id: interaction.id,
      serverId,
      channelId,
      botId: command.bot.id,
      botName: command.bot.name,
      commandName: command.name,
      expiresAt: interaction.expiresAt,
    });
    setPicked(null);
    focusInput();
  }

  function onPickerKey(event: KeyboardEvent<HTMLInputElement>): boolean {
    if (!pickerOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setPickerDismissed(true);
      return true;
    }
    if (visible.length === 0) {
      // Enter while the list is still loading would post "/roll" as text.
      if (event.key === 'Enter' && (commandsState.status === 'loading' || commandsState.status === 'idle')) {
        event.preventDefault();
        return true;
      }
      return false;
    }
    const index = active ? visible.indexOf(active) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = visible[(index + step + visible.length) % visible.length];
      if (next) setActiveId(next.id);
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && active && !event.shiftKey) {
      event.preventDefault();
      pick(active);
      return true;
    }
    return false;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = value.trim();
    if (!content || sending) return;
    if (!live || !serverId || !channelId) {
      setStatus(t('lobbyMain.composer.demo'));
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string; code?: string; rule?: string };
        // The status was stale: the composer locks now, keeping the draft.
        if (handleEmailUnverified(res.status, detail)) return;
        // The Moderation Bot's refusal is explained in the reader's language.
        if (detail.code === 'blocked_by_moderation') {
          throw new Error(t(moderationBlockedMessageKey(detail.rule)));
        }
        throw new Error(detail.error ?? t('lobbyMain.composer.failed', { status: res.status }));
      }
      const created = (await res.json()) as { message?: { id: string; content: string; userId: string | null; createdAt: string } };
      setValue('');
      setStatus(t('lobbyMain.composer.sent'));
      if (created.message) {
        window.dispatchEvent(
          new CustomEvent('lf-message-sent', {
            detail: { channelId, message: created.message },
          })
        );
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  if (emailLock.restricted) {
    // The same footprint as the composer, so the transcript does not move.
    return (
      <div className="px-4 pb-6 pt-2 bg-background z-10 sm:px-6">
        <EmailUnverifiedNotice action="message" className="min-h-[50px] px-4" />
      </div>
    );
  }

  if (command && serverId && channelId) {
    return (
      <SlashCommandForm
        key={command.id}
        command={command}
        serverId={serverId}
        channelId={channelId}
        members={members}
        channels={channels}
        onCancel={cancelCommand}
        onInvoked={onInvoked}
      />
    );
  }

  return (
    <form onSubmit={submit} className="px-4 pb-6 pt-2 bg-background z-10 sm:px-6">
      <div
        className="relative bg-surface-container-low border border-border-subtle rounded-lg flex items-center px-4 py-2 focus-within:ring-1 focus-within:ring-primary focus-within:border-primary transition-all shadow-sm"
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        {pickerOpen ? (
          <SlashCommandPicker
            listboxId={listboxId}
            commands={visible}
            activeId={active?.id ?? null}
            status={commandsState.status}
            query={query ?? ''}
            onSelect={pick}
            onHover={(c) => setActiveId(c.id)}
            onRetry={commandsState.reload}
          />
        ) : null}
        <button type="button" disabled title={t('lobbyMain.composer.attachments')} className="w-8 h-8 rounded-full flex items-center justify-center mr-2 text-text-muted opacity-50">
          <span className="material-symbols-outlined text-[20px]">add_circle</span>
        </button>
        {canRunCommands ? (
          <span id={hintId} className="sr-only">
            {t('interactions.composer.hint')}
          </span>
        ) : null}
        <MentionInput
          value={value}
          onChange={(v) => {
            setValue(v);
            setPickerDismissed(false);
            if (status === t('lobbyMain.composer.sent')) setStatus(null);
            if (v.trim() && !v.startsWith('/')) handleTyping();
          }}
          members={members}
          placeholder={t('lobbyMain.composer.placeholder', { name: channelName })}
          disabled={sending}
          inputRef={inputRef}
          onBeforeKeyDown={onPickerKey}
          inputProps={{
            'aria-label': t('lobbyMain.composer.placeholder', { name: channelName }),
            'data-composer-input': true,
            ...(canRunCommands
              ? {
                  role: 'combobox',
                  'aria-autocomplete': 'list',
                  'aria-expanded': pickerOpen,
                  'aria-controls': pickerOpen ? listboxId : undefined,
                  'aria-activedescendant': pickerOpen && active ? commandOptionId(listboxId, active) : undefined,
                  'aria-describedby': hintId,
                }
              : {}),
          }}
        />
        <div className="flex items-center gap-1 ml-2">
          <button type="button" disabled title={t('lobbyMain.composer.gifts')} className="hidden w-8 h-8 rounded items-center justify-center text-text-muted opacity-50 sm:flex">
            <span className="material-symbols-outlined text-[20px]">card_giftcard</span>
          </button>
          <button type="button" disabled title={t('lobbyMain.composer.gifs')} className="hidden w-8 h-8 rounded items-center justify-center text-text-muted opacity-50 sm:flex">
            <span className="material-symbols-outlined text-[20px]">gif_box</span>
          </button>
          <button type="submit" disabled={!value.trim() || sending} title={t('lobbyMain.composer.send')} aria-label={t('lobbyMain.composer.send')} className="w-8 h-8 rounded flex items-center justify-center hover:text-text-primary hover:bg-surface-container transition-colors text-text-secondary disabled:cursor-not-allowed disabled:opacity-40">
            <span className="material-symbols-outlined text-[20px]" aria-hidden>send</span>
          </button>
        </div>
      </div>
      {status ? (
        <p className="mt-1 text-xs text-text-muted px-2" aria-live="polite">{status}</p>
      ) : null}
    </form>
  );
}
