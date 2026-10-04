'use client';

import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import {
  interactionStore,
  useInteractionState,
  type EphemeralAnswer,
  type LocalInteraction,
} from '@/lib/bots/interaction-store';
import { formatFullTimestamp, formatMessageTimestamp } from '@/lib/chat-time';
import { BotAvatar, BotBadge } from '../BotIdentity';

/**
 * The rows slash commands add to a channel (BOT_API_V2 §3.4, §7):
 * - the "↳ <user> used /<command>" header on a bot's answer,
 * - the invoker's pending row ("<bot> is thinking…" → "<bot> did not respond"),
 * - an ephemeral answer, inline, "Only you can see this · Dismiss".
 * Plus one polite live region that reads those changes out.
 */

export function InteractionHeader({ user, command }: { user: string; command: string }) {
  const t = useT();
  return (
    <p data-interaction-header className="mb-0.5 flex min-w-0 items-center gap-1 text-xs text-text-muted">
      <span aria-hidden className="text-text-muted">↳</span>
      <span className="truncate">
        {rich(t('interactions.header'), {
          user: <span className="font-medium text-text-secondary">{user}</span>,
          command: <span className="font-mono text-primary">/{command}</span>,
        })}
      </span>
    </p>
  );
}

function focusComposer() {
  const input = document.querySelector<HTMLElement>('[data-composer-input]');
  input?.focus();
}

/** "Only you can see this · Dismiss" */
function PrivateFootnote({ onDismiss, dismissLabel }: { onDismiss: () => void; dismissLabel: string }) {
  const t = useT();
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
      <span className="material-symbols-outlined text-[14px]" aria-hidden>visibility</span>
      <span>{t('interactions.private.onlyYou')}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => {
          onDismiss();
          focusComposer();
        }}
        aria-label={dismissLabel}
        className="rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        {t('interactions.private.dismiss')}
      </button>
    </p>
  );
}

export function PendingInteractionRow({ interaction, invokerName }: { interaction: LocalInteraction; invokerName: string }) {
  const t = useT();
  const bot = interaction.botName || t('lobbyMain.chat.unknownBot');
  const pending = interaction.status === 'pending';
  return (
    <div
      data-interaction-pending
      data-status={interaction.status}
      className="flex gap-4 rounded-lg p-2 -mx-2 animate-fade-in-up"
    >
      <BotAvatar size="md" className="mt-1" />
      <div className="flex min-w-0 w-full flex-col">
        <InteractionHeader user={invokerName} command={interaction.commandName} />
        <div className="flex items-baseline gap-2">
          <span className="font-label-sm font-medium text-text-primary">{bot}</span>
          <BotBadge className="self-center" />
        </div>
        {pending ? (
          <p className="mt-1 flex items-center gap-2 font-body-md italic text-text-muted">
            <span className="flex gap-0.5" aria-hidden>
              <span className="size-1.5 rounded-full bg-text-muted animate-pulse" />
              <span className="size-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.15s' }} />
              <span className="size-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.3s' }} />
            </span>
            {t('interactions.pending.thinking', { bot })}
          </p>
        ) : (
          <>
            <p className="mt-1 flex items-center gap-1.5 font-body-md text-text-secondary">
              <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden>error</span>
              {t('interactions.pending.noResponse', { bot })}
            </p>
            <PrivateFootnote
              onDismiss={() => interactionStore.dismiss(interaction.id)}
              dismissLabel={t('interactions.private.dismissNoResponse', { bot })}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function EphemeralAnswerRow({ answer, invokerName }: { answer: EphemeralAnswer; invokerName: string }) {
  const t = useT();
  const bot = answer.botName || t('lobbyMain.chat.unknownBot');
  return (
    <div
      data-ephemeral-answer
      className="flex gap-4 rounded-lg border-l-2 border-primary bg-primary/5 p-2 -mx-2 animate-fade-in-up"
    >
      <BotAvatar size="md" className="mt-1" />
      <div className="flex min-w-0 w-full flex-col">
        {answer.commandName ? <InteractionHeader user={invokerName} command={answer.commandName} /> : null}
        <div className="flex items-baseline gap-2">
          <span className="font-label-sm font-medium text-text-primary">{bot}</span>
          <BotBadge className="self-center" />
          <span className="font-label-xs text-[11px] text-text-secondary" title={formatFullTimestamp(answer.createdAt, t)}>
            {formatMessageTimestamp(answer.createdAt, t)}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words font-body-md text-text-secondary">{answer.content}</p>
        <PrivateFootnote
          onDismiss={() => interactionStore.dismiss(answer.key)}
          dismissLabel={t('interactions.private.dismissAnswer', { bot })}
        />
      </div>
    </div>
  );
}

/**
 * Reads pending-row changes out — a row that appears with text in it is
 * not reliably announced, so the region exists before anything happens.
 */
export function InteractionAnnouncer() {
  const t = useT();
  const { announcement } = useInteractionState();
  let text = '';
  if (announcement) {
    const bot = announcement.botName || t('lobbyMain.chat.unknownBot');
    text =
      announcement.kind === 'pending'
        ? t('interactions.pending.thinking', { bot })
        : announcement.kind === 'expired'
          ? t('interactions.pending.noResponse', { bot })
          : announcement.kind === 'ephemeral'
            ? t('interactions.announce.ephemeral', { bot })
            : t('interactions.announce.answered', { bot });
  }
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-interaction-announcer>
      <span key={announcement?.seq ?? 0}>{text}</span>
    </div>
  );
}
