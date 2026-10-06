'use client';

import { Fragment, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { useT } from '@/lib/i18n/client';
import { handleEmailUnverified, requestVerificationFocus } from '@/components/email-verification/email-status-store';
import type { Translator } from '@/lib/i18n/core';
import { readMessageInteraction, readMessageWebhook, type MessageInteractionInfo, type MessageWebhookInfo } from '@/lib/bots/interaction-meta';
import { interactionStore, useInteractionState } from '@/lib/bots/interaction-store';
import { BotAvatar, BotBadge } from './BotIdentity';
import { WebhookAvatar, WebhookBadge } from './WebhookIdentity';
import { EphemeralAnswerRow, InteractionHeader, PendingInteractionRow } from './slash/InteractionRows';
import {
  formatDaySeparator,
  formatFullTimestamp,
  formatMessageTimestamp,
  isSameDay,
} from '@/lib/chat-time';

/**
 * Client island for the live lobby's chat area. Renders the message
 * list (with the same visual classes as the SSR'd demo list) and
 * subscribes to the chat WebSocket topic so new messages arrive in
 * real time. Also polls the channel + server presence endpoints every
 * 8s so the sidebar voice roster and the right-hand members panel stay
 * fresh; the polled state is exposed back to the parent through the
 * rendered output (chat area only — voice/member panels read from the
 * same initial data and refresh on next navigation for now).
 *
 * The island is mounted only when the lobby has live data (real
 * `serverId` + real `activeTextChannel`). Demo mode bypasses it and
 * keeps the SSR-only static render.
 */

interface ChatMessage {
  id: string;
  authorId: string | null;
  author: string;
  authorColor?: 'primary' | 'default';
  timestamp: string;
  /** Raw ISO instant — day separators and the exact-time tooltip need it. */
  createdAt: string;
  body: string;
  attachment?: { name: string; size: string };
  blocked?: boolean;
  pinned?: boolean;
  /** Set when a bot wrote the message — rendered with the BOT badge. */
  bot?: MessageBot | null;
  /** A bot's answer to a slash command: "↳ <user> used /<command>". */
  interaction?: MessageInteractionInfo | null;
  /** Posted by an incoming channel webhook — rendered with the WEBHOOK badge. */
  webhook?: MessageWebhookInfo | null;
}

interface MessageBot {
  id: string | null;
  name: string;
  type: string;
}

interface WsChatEnvelope {
  type: 'message';
  message: {
    id: string;
    channelId: string;
    /** null when a bot or a webhook wrote the message. */
    userId: string | null;
    botId?: string | null;
    bot?: MessageBot | null;
    content: string;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
  };
  at: string;
}

/**
 * Who wrote a message the API or the realtime feed delivered: a bot (with
 * its interaction header, if it answered a command), a webhook, a member,
 * or nobody any more.
 */
function describeAuthor(
  message: { userId: string | null; botId?: string | null; bot?: unknown; metadata?: unknown },
  names: Map<string, string>,
  t: Translator,
  unknownMember: string
): Pick<ChatMessage, 'author' | 'bot' | 'interaction' | 'webhook'> {
  const bot = message.userId ? null : asMessageBot(message.bot);
  if (bot) {
    return {
      author: bot.name || t('lobbyMain.chat.unknownBot'),
      bot,
      interaction: readMessageInteraction({ userId: message.userId, botId: message.botId ?? bot.id, metadata: message.metadata }),
      webhook: null,
    };
  }
  const webhook = readMessageWebhook(message);
  if (webhook) {
    return { author: webhook.displayName || t('interactions.webhook.unnamed'), bot: null, interaction: null, webhook };
  }
  return {
    author: message.userId ? (names.get(message.userId) ?? unknownMember) : t('lobbyMain.chat.deletedUser'),
    bot: null,
    interaction: null,
    webhook: null,
  };
}

/** A bot author from an API or realtime payload; anything malformed is not a bot. */
function asMessageBot(value: unknown): MessageBot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: typeof raw.type === 'string' ? raw.type : 'custom',
  };
}

interface PresenceApiSnapshot {
  userId: string;
  channelId: string;
  status?: string;
  lastSeen?: number;
}

export interface LobbyLiveRosterData {
  serverId: string;
  channelId: string;
  channelName: string;
  currentUserId: string | null;
  voiceChannelId: string | null;
  initialMessages: ChatMessage[];
  /** name lookup seeded by the server component from DB rows */
  knownNames: Record<string, string>;
  canManageMessages: boolean;
}

const PRESENCE_POLL_MS = 8_000;

interface TimelineItem {
  key: string;
  createdAt: string;
  node: ReactNode;
}

/** Merge two newest-first lists into one, newest first (stable for equal times). */
function mergeNewestFirst(a: TimelineItem[], b: TimelineItem[]): TimelineItem[] {
  if (b.length === 0) return a;
  const out: TimelineItem[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left && (!right || Date.parse(left.createdAt) > Date.parse(right.createdAt))) {
      out.push(left);
      i += 1;
    } else if (right) {
      out.push(right);
      j += 1;
    }
  }
  return out;
}

/** The rule between two days of conversation. */
function DaySeparator({ at }: { at: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 py-1" aria-hidden>
      <div className="h-px flex-1 bg-border-subtle/60" />
      <span className="font-label-xs text-[11px] uppercase tracking-wider text-text-muted">
        {formatDaySeparator(at, t)}
      </span>
      <div className="h-px flex-1 bg-border-subtle/60" />
    </div>
  );
}

export function LobbyLiveRoster({ data, searchQuery = '', showPinned = false }: { data: LobbyLiveRosterData; searchQuery?: string; showPinned?: boolean }) {
  const t = useT();
  const [messages, setMessages] = useState<ChatMessage[]>(data.initialMessages);
  const nameCacheRef = useRef<Map<string, string>>(new Map(Object.entries(data.knownNames)));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const notificationPrefsRef = useRef({ level: 'mentions', desktopEnabled: true, showPreview: true, sound: 'default' });
  const localRows = useInteractionState();
  /** Ids that came in through the realtime feed or the local echo. */
  const liveIdsRef = useRef<Set<string>>(new Set());

  // Sync name cache when knownNames prop changes (parent re-render with new data).
  useEffect(() => {
    for (const [k, v] of Object.entries(data.knownNames)) nameCacheRef.current.set(k, v);
  }, [data.knownNames]);

  // Answers already in the first paint settle their pending rows.
  useEffect(() => {
    for (const message of data.initialMessages) {
      if (message.interaction) interactionStore.markAnswered(message.interaction.id);
    }
  }, [data.initialMessages]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/settings/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body: { settings?: { notifications?: Record<string, unknown> } } | null) => {
        if (cancelled || !body?.settings?.notifications) return;
        const input = body.settings.notifications;
        notificationPrefsRef.current = {
          level: input.level === 'all' || input.level === 'nothing' ? input.level : 'mentions',
          desktopEnabled: typeof input.desktopEnabled === 'boolean' ? input.desktopEnabled : true,
          showPreview: typeof input.showPreview === 'boolean' ? input.showPreview : true,
          sound: typeof input.sound === 'string' ? input.sound : 'default',
        };
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Fetch the selected channel instead of relying only on the initial SSR
  // snapshot. This keeps channel switching useful even before a new WS event.
  useEffect(() => {
    let cancelled = false;
    async function loadMessages() {
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.channelId)}/messages?limit=50`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { messages?: Array<{ id: string; userId: string | null; botId?: string | null; content: string; createdAt: string; metadata?: Record<string, unknown>; blocked?: boolean; bot?: unknown }> };
        if (cancelled || !body.messages) return;
        const history: ChatMessage[] = body.messages.map((message) => {
          const who = describeAuthor(message, nameCacheRef.current, t, t('lobbyMain.chat.unknownUser'));
          // A pending row whose public answer is already in the history is done.
          if (who.interaction) interactionStore.markAnswered(who.interaction.id);
          return {
            id: message.id,
            authorId: message.userId,
            ...who,
            author: message.blocked ? t('lobbyMain.chat.blockedUser') : who.author,
            authorColor: message.userId === data.currentUserId ? 'primary' : 'default',
            timestamp: formatMessageTimestamp(message.createdAt, t),
            createdAt: message.createdAt,
            body: message.content,
            blocked: message.blocked,
            pinned: typeof message.metadata?.$pinnedAt === 'string',
          };
        });
        // A message that arrived live while the history was loading (a
        // bot's answer can come back within milliseconds) must survive it.
        setMessages((current) => {
          const known = new Set(history.map((m) => m.id));
          const live = current.filter((m) => liveIdsRef.current.has(m.id) && !known.has(m.id));
          return [...live, ...history];
        });
      } catch {
        // Realtime/local echo can continue from the current snapshot.
      }
    }
    void loadMessages();
    return () => { cancelled = true; };
  }, [data.channelId, data.currentUserId, data.serverId, t]);

  // ---- Chat WS subscribe ----
  useEffect(() => {
    const topic = `chat:${data.serverId}:${data.channelId}` as const;
    const rc = getRealtimeClient();
    const unsubscribe = rc.subscribe<WsChatEnvelope>(topic, (env) => {
      if (!env || env.type !== 'message' || !env.message) return;
      const m = env.message;
      const who = describeAuthor(m, nameCacheRef.current, t, t('lobbyMain.chat.unknownUser'));
      const author = who.author;
      // The public answer to this member's command: its pending row is done.
      if (who.interaction) interactionStore.markAnswered(who.interaction.id);
      liveIdsRef.current.add(m.id);
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        const next: ChatMessage = {
          id: m.id,
          authorId: m.userId,
          ...who,
          authorColor: m.userId === data.currentUserId ? 'primary' : 'default',
          timestamp: formatMessageTimestamp(m.createdAt, t),
          createdAt: m.createdAt,
          body: m.content,
        };
        // Newest first; UI uses flex-col-reverse so newest appears at bottom.
        return [next, ...prev];
      });
      const prefs = notificationPrefsRef.current;
      const myName = data.currentUserId ? nameCacheRef.current.get(data.currentUserId) : null;
      const mentioned = Boolean(myName && m.content.toLocaleLowerCase().includes(`@${myName.toLocaleLowerCase()}`));
      let channelMuted = false;
      try { channelMuted = window.localStorage.getItem(`lf-channel-muted:${data.channelId}`) === 'true'; } catch { /* local preference */ }
      if (
        m.userId !== data.currentUserId &&
        !channelMuted &&
        prefs.desktopEnabled &&
        prefs.level !== 'nothing' &&
        (prefs.level === 'all' || mentioned) &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.visibilityState !== 'visible'
      ) {
        // A bot or a webhook is never mistaken for a member — not even in
        // a desktop notification, which cannot show the badge.
        const titleKey = who.webhook
          ? 'lobbyMain.chat.notificationTitleWebhook'
          : who.bot
            ? 'lobbyMain.chat.notificationTitleBot'
            : 'lobbyMain.chat.notificationTitle';
        new Notification(t(titleKey, { author, channel: data.channelName }), {
          body: prefs.showPreview ? m.content : t('lobbyMain.chat.notificationBody'),
          silent: prefs.sound === 'none',
          tag: `lf-message:${data.channelId}`,
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, [data.serverId, data.channelId, data.channelName, data.currentUserId, t]);

  // ---- Local message echo — listens for 'lf-message-sent' custom events
  // dispatched by the Composer after a successful POST. This provides
  // instant feedback without depending on the WS gateway being running.
  useEffect(() => {
    function onMessageSent(e: Event) {
      const detail = (e as CustomEvent).detail as {
        channelId: string;
        message: { id: string; content: string; userId: string | null; createdAt: string };
      };
      if (!detail || detail.channelId !== data.channelId) return;
      const m = detail.message;
      liveIdsRef.current.add(m.id);
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        const author = m.userId
          ? (nameCacheRef.current.get(m.userId) ?? t('lobbyMain.chat.you'))
          : t('lobbyMain.chat.deletedUser');
        const next: ChatMessage = {
          id: m.id,
          authorId: m.userId,
          author,
          authorColor: m.userId === data.currentUserId ? 'primary' : 'default',
          timestamp: formatMessageTimestamp(m.createdAt, t),
          createdAt: m.createdAt,
          body: m.content,
        };
        return [next, ...prev];
      });
    }
    window.addEventListener('lf-message-sent', onMessageSent as EventListener);
    return () => window.removeEventListener('lf-message-sent', onMessageSent as EventListener);
  }, [data.channelId, data.currentUserId, t]);

  // ---- Presence polling (channel only — server-wide members panel uses
  // the initial SSR snapshot until the next navigation) ----
  const refreshChannelPresence = useCallback(async () => {
    if (!data.voiceChannelId) return;
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.voiceChannelId)}/presence`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const body = (await res.json()) as { presences?: PresenceApiSnapshot[] };
      if (!body.presences) return;
      for (const p of body.presences) {
        if (p.userId && !nameCacheRef.current.has(p.userId)) {
          nameCacheRef.current.set(p.userId, t('lobbyMain.chat.unknownUser'));
        }
      }
    } catch {
      // Network/endpoint hiccups are fine — next poll will retry.
    }
  }, [data.serverId, data.voiceChannelId, t]);

  // ---- Typing indicator poll ----
  const [typers, setTypers] = useState<string[]>([]);
  useEffect(() => {
    if (!data.serverId || !data.channelId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.channelId)}/typing`,
          { credentials: 'same-origin', cache: 'no-store' }
        );
        if (!res.ok) return;
        const body = (await res.json()) as { typers?: string[] };
        if (!cancelled && body.typers) setTypers(body.typers);
      } catch { /* swallow */ }
    };
    void poll();
    const id = window.setInterval(poll, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [data.serverId, data.channelId]);

  useEffect(() => {
    const id = window.setInterval(refreshChannelPresence, PRESENCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshChannelPresence]);

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleMessages = messages.filter((message) =>
    (!showPinned || message.pinned) &&
    (!normalizedSearch || `${message.author} ${message.body}`.toLocaleLowerCase().includes(normalizedSearch))
  );

  // The invoker's own rows — pending commands and answers only they can
  // see — sit in the timeline by time. They are not messages: a search or
  // the pinned view leaves them out.
  const resolveName = (id: string | null) =>
    (id ? nameCacheRef.current.get(id) : undefined) ?? t('lobbyMain.chat.unknownUser');
  const invokerName = data.currentUserId
    ? (nameCacheRef.current.get(data.currentUserId) ?? t('lobbyMain.chat.you'))
    : t('lobbyMain.chat.you');
  const filtering = showPinned || Boolean(normalizedSearch);
  const inChannel = (row: { channelId: string; serverId: string | null }) =>
    row.channelId === data.channelId && (!row.serverId || row.serverId === data.serverId);
  const local: TimelineItem[] = filtering
    ? []
    : [
        ...localRows.interactions.filter(inChannel).map((interaction) => ({
          key: `pending:${interaction.id}`,
          createdAt: interaction.createdAt,
          node: <PendingInteractionRow interaction={interaction} invokerName={invokerName} />,
        })),
        ...localRows.ephemerals.filter(inChannel).map((answer) => ({
          key: `ephemeral:${answer.key}`,
          createdAt: answer.createdAt,
          node: <EphemeralAnswerRow answer={answer} invokerName={invokerName} />,
        })),
      ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const timeline = mergeNewestFirst(
    visibleMessages.map((m) => ({
      key: m.id,
      createdAt: m.createdAt,
      node: (
        <LiveMessage
          message={m}
          invokedByName={m.interaction ? (m.interaction.invokedBy.name ?? resolveName(m.interaction.invokedBy.id)) : null}
          currentUserId={data.currentUserId}
          serverId={data.serverId}
          channelId={data.channelId}
          canManageMessages={data.canManageMessages}
          onPinnedChange={(pinned) => setMessages((current) => current.map((item) => item.id === m.id ? { ...item, pinned } : item))}
        />
      ),
    })),
    local
  );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6 flex flex-col-reverse sm:px-6">
      {timeline.length === 0 ? (
        <p className="font-body-md text-text-muted italic">
          {showPinned
            ? t('lobbyMain.chat.emptyPinned')
            : normalizedSearch
              ? t('lobbyMain.chat.emptySearch')
              : t('lobbyMain.chat.empty')}
        </p>
      ) : null}
      {timeline.map((item, index) => {
        // `timeline` is newest-first and the column is reversed, so the
        // item rendered ABOVE this one is the next entry. A separator
        // belongs here when that one fell on an earlier day (or when this
        // is the oldest item loaded).
        const older = timeline[index + 1];
        const startsDay = !older || !isSameDay(older.createdAt, item.createdAt);
        return (
          <Fragment key={item.key}>
            {item.node}
            {startsDay ? <DaySeparator at={item.createdAt} /> : null}
          </Fragment>
        );
      })}
      {typers.length > 0 ? (
        <div className="px-2 py-1 flex items-center gap-2 text-xs text-text-muted animate-fade-in-up">
          <div className="flex gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.15s' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.3s' }} />
          </div>
          <span>
            {typers.length === 1
              ? t('lobbyMain.chat.typingOne', { first: typers[0] ?? '' })
              : typers.length === 2
                ? t('lobbyMain.chat.typingTwo', { first: typers[0] ?? '', second: typers[1] ?? '' })
                : t('lobbyMain.chat.typingMany', { first: typers[0] ?? '', count: typers.length - 1 })}
          </span>
        </div>
      ) : null}
      <ChannelWelcome channelName={data.channelName} />
    </div>
  );
}

function LiveMessage({ message, invokedByName, currentUserId, serverId, channelId, canManageMessages, onPinnedChange }: { message: ChatMessage; invokedByName: string | null; currentUserId: string | null; serverId: string; channelId: string; canManageMessages: boolean; onPinnedChange: (pinned: boolean) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.body);
  const isOwn = message.authorId === currentUserId;

  async function saveEdit() {
    const trimmed = editValue.trim();
    if (!trimmed || !message.id) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages/${message.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed }),
      });
      // EMAIL.md §4.2: an edit is a post. Keep the edit open and point at
      // the banner's code field instead of dropping it silently.
      if (handleEmailUnverified(res.status, await res.clone().json().catch(() => null))) {
        requestVerificationFocus();
        return;
      }
      if (!res.ok) throw new Error(`edit failed: ${res.status}`);
    } catch { /* non-fatal */ }
    setEditing(false);
  }

  async function deleteMessage() {
    if (!message.id) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages/${message.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
    } catch { /* non-fatal */ }
  }

  async function togglePinned() {
    const pinned = !message.pinned;
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages/${message.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error(`pin failed: ${res.status}`);
      onPinnedChange(pinned);
    } catch { /* non-fatal */ }
  }

  if (message.blocked) {
    return (
      <div className="flex gap-4 group p-2 -mx-2 rounded-lg opacity-50 animate-fade-in-up">
        <div className="w-10 h-10 rounded-full bg-surface-container flex-shrink-0 mt-1 flex items-center justify-center">
          <span className="material-symbols-outlined text-danger text-[20px]">block</span>
        </div>
        <div className="flex flex-col w-full">
          <span className="font-label-sm font-medium text-text-muted">{t('lobbyMain.chat.blockedUser')}</span>
          <p className="font-body-md text-text-muted mt-1 italic">{message.body}</p>
        </div>
      </div>
    );
  }
  const authorColorClass = message.authorColor === 'primary' ? 'text-primary' : 'text-text-primary';
  return (
    <div data-chat-message data-bot-message={message.bot ? 'true' : undefined} data-webhook-message={message.webhook ? 'true' : undefined} className="flex gap-4 group hover:bg-surface-container/30 p-2 -mx-2 rounded-lg transition-colors animate-fade-in-up relative">
      {message.bot ? (
        <BotAvatar size="md" className="mt-1" />
      ) : message.webhook ? (
        <WebhookAvatar className="mt-1" />
      ) : (
        <div data-chat-avatar className="chat-avatar w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center font-bold text-text-primary">
          {message.author.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex flex-col w-full min-w-0">
        {message.bot && message.interaction ? (
          <InteractionHeader
            user={invokedByName ?? t('lobbyMain.chat.unknownUser')}
            command={message.interaction.commandName}
          />
        ) : null}
        <div className="flex items-baseline gap-2">
          <span className={`font-label-sm font-medium ${authorColorClass}`}>{message.author}</span>
          {message.bot ? <BotBadge className="self-center" /> : message.webhook ? <WebhookBadge className="self-center" /> : null}
          <span
            className="font-label-xs text-[11px] text-text-secondary"
            title={formatFullTimestamp(message.createdAt, t)}
          >
            {message.timestamp}
          </span>
          {message.pinned ? <span className="material-symbols-outlined text-[13px] text-primary" title={t('lobbyMain.chat.pinned')}>push_pin</span> : null}
        </div>
        {editing ? (
          <div className="mt-1 flex gap-2">
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(false); }}
              autoFocus
              className="flex-1 bg-surface-container border border-border-subtle rounded px-2 py-1 text-body-md text-text-primary outline-none focus:border-primary"
            />
            <button onClick={saveEdit} className="text-xs px-2 py-1 bg-primary-container text-on-primary-container rounded font-medium">{t('lobbyMain.chat.save')}</button>
            <button onClick={() => setEditing(false)} className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary">{t('lobbyMain.chat.cancel')}</button>
          </div>
        ) : (
          <p className="font-body-md text-text-secondary mt-1 whitespace-pre-wrap break-words">{message.body}</p>
        )}
      </div>
      {/* Hover action menu — only for own messages */}
      {(isOwn || canManageMessages) && !editing ? (
        <div className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-surface-raised rounded-md border border-border-subtle shadow-sm">
          {canManageMessages ? <button
            type="button"
            onClick={() => void togglePinned()}
            title={message.pinned ? t('lobbyMain.chat.unpin') : t('lobbyMain.chat.pin')}
            className={message.pinned ? 'p-1 text-primary' : 'p-1 text-text-secondary hover:text-primary'}
          >
            <span className="material-symbols-outlined text-[16px]">push_pin</span>
          </button> : null}
          {isOwn ? <button
            type="button"
            onClick={() => { setEditing(true); setEditValue(message.body); }}
            title={t('lobbyMain.chat.edit')}
            className="p-1 text-text-secondary hover:text-text-primary"
          >
            <span className="material-symbols-outlined text-[16px]">edit</span>
          </button> : null}
          <button
            type="button"
            onClick={deleteMessage}
            title={t('lobbyMain.chat.delete')}
            className="p-1 text-text-secondary hover:text-danger"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChannelWelcome({ channelName }: { channelName: string }) {
  const t = useT();
  return (
    <div className="py-12 flex flex-col items-start border-b border-border-subtle/30 mb-4">
      <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-[32px] text-text-primary">tag</span>
      </div>
      <h1 className="font-section-h2-mobile text-text-primary mb-2">
        {t('lobbyMain.channel.welcomeTitle', { name: channelName })}
      </h1>
      <p className="font-body-md text-text-secondary">
        {t('lobbyMain.channel.welcomeBody', { name: channelName })}
      </p>
    </div>
  );
}
