'use client';

import { Fragment, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { handleEmailUnverified, requestVerificationFocus } from '@/components/email-verification/email-status-store';
import type { Translator } from '@/lib/i18n/core';
import {
  readMessageApp,
  readMessageInteraction,
  readMessageWebhook,
  type MessageAppInfo,
  type MessageInteractionInfo,
  type MessageWebhookInfo,
} from '@/lib/bots/interaction-meta';
import { pluginName } from '@/lib/plugin-catalog-text';
import { interactionStore, useInteractionState } from '@/lib/bots/interaction-store';
import { botDisplayName, localizeBotMessage } from '@/lib/bots/bot-i18n';
import { BotAvatar, BotBadge } from './BotIdentity';
import { WebhookAvatar, WebhookBadge } from './WebhookIdentity';
import { AppAvatar, AppBadge } from './AppIdentity';
import { EphemeralAnswerRow, InteractionHeader, PendingInteractionRow } from './slash/InteractionRows';
import { ChatPollCard } from './ChatPollCard';
import { useBlockList } from './BlockListProvider';
import { ProfileTrigger, useProfileCard } from './ProfileCardProvider';
import { composerRefusalMessage } from '@/lib/chat-refusals';
import { mentionsEveryoneOrHere } from '@/lib/everyone-mention';
import { readMessageMentions, splitMentions, type StoredMention } from '@/lib/mentions';
import { useHydrated } from '@/lib/use-hydrated';
import {
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  playNotificationSound,
  shouldNotify,
  type NotificationPrefs,
} from '@/lib/notification-prefs';
import { isInVoiceRoom } from '@/lib/voice-connection';
import { useOptionalLobbyVoice } from './LobbyVoiceProvider';
import {
  applyChatPollUpdate,
  asChatPollUpdate,
  asChatPollView,
  catchUpChatPoll,
  type ChatPollUpdate,
  type ChatPollView,
} from '@/lib/chat-polls';
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
  /** Posted by a game plugin during an activity (`chat.post`) — rendered with the APP badge. */
  app?: MessageAppInfo | null;
  /** A poll message (docs/CHAT_POLLS.md): the poll as this viewer sees it. */
  poll?: ChatPollView | null;
  /** Members the message names (docs/PROFILES.md "Mentions"). */
  mentions?: StoredMention[];
}

interface MessageBot {
  id: string | null;
  name: string;
  type: string;
  /** The server says the name is a built-in default: show it in the viewer's language. */
  defaultName?: boolean;
}

interface WsChatMessageEnvelope {
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
    /** A poll message carries its poll (no votes yet). */
    poll?: unknown;
  };
  at: string;
}

/**
 * Everything the chat topic carries. Edits and deletes carry ids only: an
 * edited message is refetched through the REST route (which re-checks
 * access), a deleted one is dropped. A poll update carries public counts.
 */
type WsChatEnvelope =
  | WsChatMessageEnvelope
  | { type: 'message_update'; message?: { id?: unknown }; at?: string }
  | { type: 'message_delete'; id?: unknown; message?: { id?: unknown }; at?: string }
  | { type: 'poll_update'; poll?: unknown; at?: string };

/** The fields of a REST message payload the roster reads. */
interface ApiMessage {
  id: string;
  userId: string | null;
  botId?: string | null;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  blocked?: boolean;
  bot?: unknown;
  poll?: unknown;
}

/**
 * Who wrote a message the API or the realtime feed delivered: a bot (with
 * its interaction header, if it answered a command), a webhook, an app (a
 * game plugin), a member, or nobody any more.
 */
function describeAuthor(
  message: { userId: string | null; botId?: string | null; bot?: unknown; metadata?: unknown },
  names: Map<string, string>,
  t: Translator,
  unknownMember: string
): Pick<ChatMessage, 'author' | 'bot' | 'interaction' | 'webhook' | 'app'> {
  const bot = message.userId ? null : asMessageBot(message.bot);
  if (bot) {
    return {
      author: botDisplayName(bot, t, t('lobbyMain.chat.unknownBot')),
      bot,
      interaction: readMessageInteraction({ userId: message.userId, botId: message.botId ?? bot.id, metadata: message.metadata }),
      webhook: null,
      app: null,
    };
  }
  const webhook = readMessageWebhook(message);
  if (webhook) {
    return { author: webhook.displayName || t('interactions.webhook.unnamed'), bot: null, interaction: null, webhook, app: null };
  }
  const app = readMessageApp(message);
  if (app) {
    // The plugin's own translation of its name when this browser knows it.
    return { author: pluginName(app.pluginId, t.locale, app.name), bot: null, interaction: null, webhook: null, app };
  }
  return {
    author: message.userId ? (names.get(message.userId) ?? unknownMember) : t('lobbyMain.chat.deletedUser'),
    bot: null,
    interaction: null,
    webhook: null,
    app: null,
  };
}

/**
 * A blocked author's message as the viewer sees it — the same placeholder
 * the server render (`buildMessages` in page.tsx) and the REST list give:
 * no author, no words, no poll (security-review AUTHZ-009).
 */
function blockedChatMessage(id: string, createdAt: string, t: Translator): ChatMessage {
  return {
    id,
    authorId: null,
    author: t('lobbyMain.chat.blockedUser'),
    authorColor: 'default',
    timestamp: formatMessageTimestamp(createdAt, t),
    createdAt,
    body: t('lobbyMain.chat.blockedBody'),
    blocked: true,
    bot: null,
    interaction: null,
    webhook: null,
    app: null,
    poll: null,
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
    ...(raw.defaultName === true ? { defaultName: true } : {}),
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

/** Messages per page: the first read, a reconnect's re-read and each "Load older messages". */
const PAGE_SIZE = 50;

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
  // The day is the reader's (their time zone), not the server's: worked
  // out in the browser, after hydration.
  const hydrated = useHydrated();
  return (
    <div className="flex items-center gap-3 py-1" aria-hidden>
      <div className="h-px flex-1 bg-border-subtle/60" />
      <span className="font-label-xs text-[11px] uppercase tracking-wider text-text-muted">
        {hydrated ? formatDaySeparator(at, t) : '\u00a0'}
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
  const notificationPrefsRef = useRef<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  // "Suppress while in voice" (Settings → Notifications) needs to know.
  const voice = useOptionalLobbyVoice();
  const inVoiceRef = useRef(false);
  inVoiceRef.current = Boolean(voice?.activeChannelId) && isInVoiceRoom(voice?.connectionState ?? null);
  const localRows = useInteractionState();
  /** Ids that came in through the realtime feed or the local echo. */
  const liveIdsRef = useRef<Set<string>>(new Set());
  /** Messages deleted while this view was open — a late history page must not bring them back. */
  const deletedIdsRef = useRef<Set<string>>(new Set());
  /**
   * The newest `poll_update` seen per poll. A REST answer or a history page
   * can be older than the card on screen; it is brought up to this one.
   */
  const pollUpdatesRef = useRef<Map<string, ChatPollUpdate>>(new Map());
  const catchUp = useCallback(
    (poll: ChatPollView | null): ChatPollView | null => (poll ? catchUpChatPoll(poll, pollUpdatesRef.current.get(poll.id)) : null),
    []
  );
  /**
   * security-review AUTHZ-009: the viewer's block list (BlockListProvider).
   * The server render and the REST list mask a blocked author's messages;
   * the realtime feed and the local echo now do the same, and a blocked
   * author never raises a desktop notification. Read through a ref so the
   * chat subscription does not restart when the list changes.
   */
  const { blockedIds } = useBlockList();
  const blockedIdsRef = useRef(blockedIds);
  /** Bumped to read the channel again (an unblock: the masked messages come back). */
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    const before = blockedIdsRef.current;
    blockedIdsRef.current = blockedIds;
    // Someone unblocked: their placeholders turn back into messages, which
    // only the server can give back.
    if ([...before].some((id) => !blockedIds.has(id))) setReloadTick((tick) => tick + 1);
    // Someone blocked while the view is open (or a list that loaded after
    // the first live message): their messages on screen are masked too.
    if (blockedIds.size === 0) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((message) => {
        if (message.blocked || !message.authorId || !blockedIds.has(message.authorId)) return message;
        changed = true;
        return blockedChatMessage(message.id, message.createdAt, t);
      });
      return changed ? next : prev;
    });
  }, [blockedIds, t]);

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
    void loadNotificationPrefs().then((prefs) => {
      if (!cancelled) notificationPrefsRef.current = prefs;
    });
    return () => { cancelled = true; };
  }, []);

  // Auto-scroll to the bottom when a NEWER message arrives - not when an
  // older page is added at the top, which would yank the reader away.
  const newestId = messages[0]?.id ?? null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [newestId]);

  /** A REST message as a chat row, in this viewer's language. */
  const toChatMessage = useCallback(
    (message: ApiMessage): ChatMessage => {
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
        // A built-in bot's default text in this viewer's language; a
        // blocked author's placeholder in it too, like the server render.
        body: message.blocked ? t('lobbyMain.chat.blockedBody') : localizeBotMessage(message, t),
        blocked: message.blocked,
        pinned: typeof message.metadata?.$pinnedAt === 'string',
        poll: message.blocked ? null : catchUp(asChatPollView(message.poll)),
        mentions: message.blocked ? [] : readMessageMentions(message.metadata),
      };
    },
    [catchUp, data.currentUserId, t]
  );

  /**
   * Whether the channel has messages older than the ones loaded - null
   * until the first page answers. "Load older messages" reads them a page
   * at a time (the `before` cursor of the messages route).
   */
  const [hasOlder, setHasOlder] = useState<boolean | null>(null);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'error'>('idle');

  // Fetch the selected channel instead of relying only on the initial SSR
  // snapshot. This keeps channel switching useful even before a new WS event.
  useEffect(() => {
    let cancelled = false;
    async function loadMessages() {
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.channelId)}/messages?limit=${PAGE_SIZE}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { messages?: ApiMessage[] };
        if (cancelled || !body.messages) return;
        const history: ChatMessage[] = body.messages.map(toChatMessage);
        const fullPage = body.messages.length >= PAGE_SIZE;
        setHasOlder((current) => current ?? fullPage);
        // A message that arrived live while the history was loading (a
        // bot's answer can come back within milliseconds) must survive it,
        // and so must what happened live meanwhile: a delete stays deleted,
        // and a poll the viewer voted on keeps their choice.
        setMessages((current) => {
          const known = new Set(history.map((m) => m.id));
          const byId = new Map(current.map((m) => [m.id, m]));
          // A live message older than the newest one in the answer, yet
          // missing from it, was deleted meanwhile (a reconnect re-read).
          const newest = history[0] ? Date.parse(history[0].createdAt) : null;
          const live = current.filter(
            (m) => liveIdsRef.current.has(m.id) && !known.has(m.id) && (newest === null || Date.parse(m.createdAt) > newest)
          );
          const merged = history
            .filter((m) => !deletedIdsRef.current.has(m.id))
            .map((m) => {
              const shown = byId.get(m.id)?.poll;
              return shown && m.poll && shown.id === m.poll.id && shown.version > m.poll.version ? { ...m, poll: shown } : m;
            });
          // Older pages the viewer loaded stay below the newest page (a
          // reconnect re-reads only the newest one).
          const oldestRead = history.length > 0 ? Date.parse(history[history.length - 1]!.createdAt) : null;
          const older =
            oldestRead === null || history.length < PAGE_SIZE
              ? []
              : current.filter((m) => !known.has(m.id) && !liveIdsRef.current.has(m.id) && Date.parse(m.createdAt) < oldestRead);
          return [...live, ...merged, ...older];
        });
      } catch {
        // Realtime/local echo can continue from the current snapshot.
      }
    }
    void loadMessages();
    // The gateway keeps no backlog and replays nothing: whatever was posted,
    // edited or deleted before the chat topic was live — after the read
    // above, or while the socket was down (sleep, a network change, a
    // gateway restart) — is read again once the gateway confirms the topic.
    // The topic's one wire subscription is shared with the handler below;
    // the merge keeps live rows and deletions.
    const offLive = getRealtimeClient().subscribe(`chat:${data.serverId}:${data.channelId}`, () => {}, {
      onLive: () => void loadMessages(),
    });
    return () => {
      cancelled = true;
      offLive();
    };
  }, [data.channelId, data.serverId, reloadTick, toChatMessage]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[messages.length - 1];
    if (!oldest || olderState === 'loading') return;
    setOlderState('loading');
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.channelId)}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.createdAt)}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { messages?: ApiMessage[] };
      const page = (body.messages ?? []).map(toChatMessage).filter((m) => !deletedIdsRef.current.has(m.id));
      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        return [...current, ...page.filter((m) => !known.has(m.id))];
      });
      setHasOlder((body.messages ?? []).length >= PAGE_SIZE);
      setOlderState('idle');
    } catch {
      setOlderState('error');
    }
  }, [data.channelId, data.serverId, messages, olderState, toChatMessage]);

  // An edit (or anything else that changed a message) arrived as an id:
  // reload that one message through the REST route — it re-checks access
  // and projects a poll for this viewer. Gone (404) means drop it.
  const refreshMessage = useCallback(async (messageId: string) => {
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(data.serverId)}/channels/${encodeURIComponent(data.channelId)}/messages/${encodeURIComponent(messageId)}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      if (res.status === 404) {
        setMessages((prev) => prev.filter((x) => x.id !== messageId));
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { message?: ApiMessage };
      const message = body.message;
      if (!message) return;
      setMessages((prev) =>
        prev.map((x) =>
          x.id === messageId
            ? {
                ...x,
                body: x.blocked ? x.body : localizeBotMessage(message, t),
                pinned: typeof message.metadata?.$pinnedAt === 'string',
                mentions: x.blocked ? [] : readMessageMentions(message.metadata),
                ...(message.poll !== undefined && !x.blocked ? { poll: catchUp(asChatPollView(message.poll)) } : {}),
              }
            : x
        )
      );
    } catch {
      // The next history load corrects it.
    }
  }, [catchUp, data.serverId, data.channelId, t]);

  // ---- Chat WS subscribe ----
  useEffect(() => {
    const topic = `chat:${data.serverId}:${data.channelId}` as const;
    const rc = getRealtimeClient();
    const unsubscribe = rc.subscribe<WsChatEnvelope>(topic, (env) => {
      if (!env || typeof env !== 'object') return;
      if (env.type === 'message_update') {
        const id = env.message?.id;
        if (typeof id === 'string') void refreshMessage(id);
        return;
      }
      if (env.type === 'message_delete') {
        const id = typeof env.id === 'string' ? env.id : env.message?.id;
        if (typeof id !== 'string') return;
        deletedIdsRef.current.add(id);
        setMessages((prev) => prev.filter((x) => x.id !== id));
        return;
      }
      if (env.type === 'poll_update') {
        const update = asChatPollUpdate(env.poll);
        if (!update) return;
        const seen = pollUpdatesRef.current.get(update.id);
        if (!seen || seen.version <= update.version) pollUpdatesRef.current.set(update.id, update);
        setMessages((prev) =>
          prev.map((x) => (x.id === update.messageId && x.poll ? { ...x, poll: applyChatPollUpdate(x.poll, update) } : x))
        );
        return;
      }
      if (env.type !== 'message' || !env.message) return;
      const m = env.message;
      if (m.userId && blockedIdsRef.current.has(m.userId)) {
        // AUTHZ-009: the same placeholder the server render shows — no
        // words, no poll, no author — and no notification.
        liveIdsRef.current.add(m.id);
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [blockedChatMessage(m.id, m.createdAt, t), ...prev]
        );
        return;
      }
      const who = describeAuthor(m, nameCacheRef.current, t, t('lobbyMain.chat.unknownUser'));
      const author = who.author;
      // A built-in bot's default text in this viewer's language.
      const body = localizeBotMessage(m, t);
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
          body,
          poll: asChatPollView(m.poll),
          mentions: readMessageMentions(m.metadata),
        };
        // Newest first; UI uses flex-col-reverse so newest appears at bottom.
        return [next, ...prev];
      });
      const prefs = notificationPrefsRef.current;
      // docs/PROFILES.md "Mentions": the message names this member, or
      // pings everyone; a message from before mention ids still counts by
      // its text.
      const myName = data.currentUserId ? nameCacheRef.current.get(data.currentUserId) : null;
      const mentioned =
        readMessageMentions(m.metadata).some((mention) => mention.userId === data.currentUserId) ||
        (Boolean(m.userId) && mentionsEveryoneOrHere(m.content)) ||
        Boolean(myName && m.content.toLocaleLowerCase().includes(`@${myName.toLocaleLowerCase()}`));
      let channelMuted = false;
      try { channelMuted = window.localStorage.getItem(`lf-channel-muted:${data.channelId}`) === 'true'; } catch { /* local preference */ }
      if (
        m.userId !== data.currentUserId &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        shouldNotify(prefs, {
          mentioned,
          inVoice: inVoiceRef.current,
          channelMuted,
          hidden: document.visibilityState !== 'visible',
        })
      ) {
        // A bot, a webhook or an app is never mistaken for a member — not
        // even in a desktop notification, which cannot show the badge.
        const titleKey = who.webhook
          ? 'lobbyMain.chat.notificationTitleWebhook'
          : who.bot
            ? 'lobbyMain.chat.notificationTitleBot'
            : who.app
              ? 'lobbyMain.chat.notificationTitleApp'
              : 'lobbyMain.chat.notificationTitle';
        new Notification(t(titleKey, { author, channel: data.channelName }), {
          body: prefs.showPreview ? body : t('lobbyMain.chat.notificationBody'),
          // The page plays the chosen sound itself (default chime, soft
          // pop, or none) instead of the system's.
          silent: true,
          tag: `lf-message:${data.channelId}`,
        });
        playNotificationSound(prefs.sound);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [data.serverId, data.channelId, data.channelName, data.currentUserId, refreshMessage, t]);

  // ---- Local message echo — listens for 'lf-message-sent' custom events
  // dispatched by the Composer after a successful POST. This provides
  // instant feedback without depending on the WS gateway being running.
  useEffect(() => {
    function onMessageSent(e: Event) {
      const detail = (e as CustomEvent).detail as {
        channelId: string;
        message: { id: string; content: string; userId: string | null; createdAt: string; metadata?: Record<string, unknown> };
        /** Set when the composer posted a poll. */
        poll?: unknown;
      };
      if (!detail || detail.channelId !== data.channelId) return;
      const m = detail.message;
      liveIdsRef.current.add(m.id);
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        // The echo is the viewer's own post, but it goes through the same
        // block rule as the realtime feed (AUTHZ-009).
        if (m.userId && blockedIdsRef.current.has(m.userId)) {
          return [blockedChatMessage(m.id, m.createdAt, t), ...prev];
        }
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
          poll: asChatPollView(detail.poll),
          mentions: readMessageMentions(m.metadata),
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
          onEdited={(body) => setMessages((current) => current.map((item) => item.id === m.id ? { ...item, body } : item))}
          onDeleted={() => {
            deletedIdsRef.current.add(m.id);
            setMessages((current) => current.filter((item) => item.id !== m.id));
          }}
          onPollChange={(poll) => setMessages((current) => current.map((item) => item.id === m.id ? { ...item, poll: catchUp(poll) } : item))}
        />
      ),
    })),
    local
  );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6 flex flex-col-reverse sm:px-6">
      {/* The column is reversed: the first child sits at the BOTTOM, under
          the newest message - where "is typing..." belongs (it used to sit
          above the oldest one, out of sight in a long channel). */}
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
      {hasOlder && !filtering ? (
        <div className="flex flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={olderState === 'loading'}
            className="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            data-testid="chat-load-older"
          >
            {olderState === 'loading' ? t('lobbyMain.chat.loadingOlder') : t('lobbyMain.chat.loadOlder')}
          </button>
          {olderState === 'error' ? (
            <p role="alert" className="text-xs text-danger">
              {t('lobbyMain.chat.loadOlderFailed')}
            </p>
          ) : null}
        </div>
      ) : (
        <ChannelWelcome channelName={data.channelName} />
      )}
    </div>
  );
}

function LiveMessage({ message, invokedByName, currentUserId, serverId, channelId, canManageMessages, onPinnedChange, onEdited, onDeleted, onPollChange }: { message: ChatMessage; invokedByName: string | null; currentUserId: string | null; serverId: string; channelId: string; canManageMessages: boolean; onPinnedChange: (pinned: boolean) => void; onEdited: (body: string) => void; onDeleted: () => void; onPollChange: (poll: ChatPollView) => void }) {
  const t = useT();
  const profile = useProfileCard();
  const hydrated = useHydrated();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Why the last edit, delete or pin was refused — shown under the message. */
  const [actionError, setActionError] = useState<string | null>(null);
  const isOwn = message.authorId === currentUserId;
  const isMember = Boolean(message.authorId) && !message.bot && !message.webhook && !message.app;
  // docs/PROFILES.md "Live updates": a member's name as the lobby knows it
  // now (a rename shows on their old messages too).
  const author = (isMember && message.authorId ? profile?.seedFor(message.authorId)?.displayName : null) ?? message.author;
  // Discord's highlight: the message names this member, or pings everyone.
  const mentionsMe =
    Boolean(currentUserId) &&
    !isOwn &&
    (Boolean(message.mentions?.some((mention) => mention.userId === currentUserId)) ||
      (isMember && mentionsEveryoneOrHere(message.body)));

  /** The route's refusal, in this viewer's language. */
  async function refusal(res: Response): Promise<string> {
    const detail = (await res.json().catch(() => ({}))) as { code?: string; rule?: string; until?: string };
    return composerRefusalMessage(t, res.status, detail);
  }

  async function saveEdit() {
    const trimmed = editValue.trim();
    if (!trimmed || !message.id || busy) return;
    if (trimmed === message.body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setActionError(null);
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
      // A refused edit keeps the editor open with the reason; the text is not lost.
      if (!res.ok) {
        setActionError(await refusal(res));
        return;
      }
      // Shown at once; the realtime `message_update` brings it to everyone else.
      onEdited(trimmed);
      setEditing(false);
    } catch {
      setActionError(t('lobbyMain.chat.actionNetwork'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage() {
    if (!message.id || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages/${message.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setActionError(await refusal(res));
        return;
      }
      onDeleted();
    } catch {
      setActionError(t('lobbyMain.chat.actionNetwork'));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  async function togglePinned() {
    if (busy) return;
    const pinned = !message.pinned;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/messages/${message.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) {
        setActionError(await refusal(res));
        return;
      }
      onPinnedChange(pinned);
    } catch {
      setActionError(t('lobbyMain.chat.actionNetwork'));
    } finally {
      setBusy(false);
    }
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
  const actionButton =
    'grid size-7 place-items-center rounded text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';
  return (
    <div
      data-chat-message
      data-bot-message={message.bot ? 'true' : undefined}
      data-webhook-message={message.webhook ? 'true' : undefined}
      data-app-message={message.app ? 'true' : undefined}
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`flex gap-4 group p-2 -mx-2 rounded-lg transition-colors animate-fade-in-up relative ${
        mentionsMe ? 'bg-ember/10 shadow-[inset_2px_0_0_var(--lf-ember,#E7B86A)] hover:bg-ember/15' : 'hover:bg-surface-container/30'
      }`}
    >
      {message.bot ? (
        <BotAvatar size="md" className="mt-1" />
      ) : message.webhook ? (
        <WebhookAvatar className="mt-1" />
      ) : message.app ? (
        <AppAvatar className="mt-1" />
      ) : (
        <ChatAuthorAvatar authorId={message.authorId} name={author} />
      )}
      <div className="flex flex-col w-full min-w-0">
        {message.bot && message.interaction ? (
          <InteractionHeader
            user={invokedByName ?? t('lobbyMain.chat.unknownUser')}
            command={message.interaction.commandName}
          />
        ) : null}
        <div className="flex items-baseline gap-2">
          {isMember ? (
            <ProfileTrigger
              userId={message.authorId}
              seed={{ displayName: author }}
              className={`font-label-sm font-medium ${authorColorClass} rounded-sm hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary`}
              testId="chat-author"
            >
              {author}
            </ProfileTrigger>
          ) : (
            <span className={`font-label-sm font-medium ${authorColorClass}`}>{author}</span>
          )}
          {message.bot ? (
            <BotBadge className="self-center" />
          ) : message.webhook ? (
            <WebhookBadge className="self-center" />
          ) : message.app ? (
            <AppBadge name={author} className="self-center" />
          ) : null}
          <span
            className="font-label-xs text-[11px] text-text-secondary"
            // The exact time in the reader's time zone — after hydration, so
            // the server's (UTC) value never sticks to the attribute.
            title={hydrated ? formatFullTimestamp(message.createdAt, t) : undefined}
          >
            {hydrated ? formatMessageTimestamp(message.createdAt, t) : message.timestamp}
          </span>
          {message.pinned ? <span className="material-symbols-outlined text-[13px] text-primary" title={t('lobbyMain.chat.pinned')}>push_pin</span> : null}
        </div>
        {editing ? (
          <div className="mt-1 flex gap-2">
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveEdit();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setActionError(null);
                }
              }}
              aria-label={t('lobbyMain.chat.editLabel')}
              autoFocus
              className="flex-1 bg-surface-container border border-border-subtle rounded px-2 py-1 text-body-md text-text-primary outline-none focus:border-primary"
            />
            <button type="button" disabled={busy} onClick={() => void saveEdit()} className="text-xs px-2 py-1 bg-primary-container text-on-primary-container rounded font-medium disabled:opacity-50">{t('lobbyMain.chat.save')}</button>
            <button type="button" onClick={() => { setEditing(false); setActionError(null); }} className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary">{t('lobbyMain.chat.cancel')}</button>
          </div>
        ) : message.poll ? (
          <ChatPollCard
            poll={message.poll}
            serverId={serverId}
            channelId={channelId}
            canClose={isOwn || canManageMessages}
            onChange={onPollChange}
          />
        ) : (
          <MessageText text={message.body} mentions={isMember ? message.mentions : undefined} />
        )}
        {confirmingDelete ? (
          <div role="group" aria-label={t('lobbyMain.chat.deleteConfirm')} className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            <span className="text-text-primary">{t('lobbyMain.chat.deleteConfirm')}</span>
            <button
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => void deleteMessage()}
              className="rounded bg-danger px-2 py-1 text-xs font-semibold text-background disabled:opacity-50"
              data-testid="chat-delete-confirm"
            >
              {t('lobbyMain.chat.delete')}
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
              {t('lobbyMain.chat.cancel')}
            </button>
          </div>
        ) : null}
        {actionError ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {actionError}
          </p>
        ) : null}
      </div>
      {/* Hover action menu. Shown on hover, on keyboard focus inside it,
          and always on touch screens (an invisible button is never tapped
          by accident). */}
      {(isOwn || canManageMessages) && !editing && !confirmingDelete ? (
        <div className="absolute top-1 right-2 flex items-center gap-0.5 rounded-md border border-border-subtle bg-surface-raised opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {canManageMessages ? <button
            type="button"
            disabled={busy}
            onClick={() => void togglePinned()}
            title={message.pinned ? t('lobbyMain.chat.unpin') : t('lobbyMain.chat.pin')}
            aria-label={message.pinned ? t('lobbyMain.chat.unpin') : t('lobbyMain.chat.pin')}
            className={`${actionButton} ${message.pinned ? 'text-primary' : 'hover:text-primary'}`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>push_pin</span>
          </button> : null}
          {isOwn && !message.poll && isMember ? <button
            type="button"
            onClick={() => { setEditing(true); setEditValue(message.body); setActionError(null); }}
            title={t('lobbyMain.chat.edit')}
            aria-label={t('lobbyMain.chat.edit')}
            className={`${actionButton} hover:text-text-primary`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>edit</span>
          </button> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => { setConfirmingDelete(true); setActionError(null); }}
            title={t('lobbyMain.chat.delete')}
            aria-label={t('lobbyMain.chat.delete')}
            className={`${actionButton} hover:text-danger`}
            data-testid="chat-delete"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>delete</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A message's text with its mentions (docs/PROFILES.md "Mentions"): each
 * member it names is a chip that opens their profile card; `@everyone` and
 * `@here` are marked but name nobody.
 */
function MessageText({ text, mentions }: { text: string; mentions?: StoredMention[] }) {
  const t = useT();
  const segments = useMemo(() => splitMentions(text, mentions ?? []), [text, mentions]);
  return (
    <p className="font-body-md text-text-secondary mt-1 whitespace-pre-wrap break-words">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : segment.kind === 'mass' ? (
          <span key={index} className="rounded bg-ember/15 px-0.5 font-medium text-text-primary" data-mass-mention>
            {segment.text}
          </span>
        ) : (
          <ProfileTrigger
            key={index}
            userId={segment.userId}
            seed={{ displayName: segment.text.slice(1) }}
            label={t('lobbyMain.chat.mentionLabel', { name: segment.text.slice(1) })}
            className="rounded bg-primary/15 px-0.5 font-medium text-primary transition-colors hover:bg-primary/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            testId="chat-mention"
          >
            {segment.text}
          </ProfileTrigger>
        )
      )}
    </p>
  );
}

/**
 * A member's avatar beside their message: their photo when the lobby knows
 * it (the member list's projected avatar), else their initial. A click
 * opens their profile card — the author's name next to it is the keyboard
 * path to the same card, so this one stays out of the tab order.
 */
function ChatAuthorAvatar({ authorId, name }: { authorId: string | null; name: string }) {
  const t = useT();
  const profile = useProfileCard();
  const avatarUrl = authorId ? (profile?.seedFor(authorId)?.avatarUrl ?? null) : null;
  return (
    <ProfileTrigger
      userId={authorId}
      seed={{ displayName: name }}
      decorative
      className="chat-avatar w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center overflow-hidden font-bold text-text-primary transition-[filter] hover:brightness-90"
      testId="chat-avatar"
      markers={{ 'data-chat-avatar': true }}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin avatar route
        <img src={avatarUrl} alt="" className="size-full object-cover" />
      ) : (
        initialOf(name, { locale: t.locale })
      )}
    </ProfileTrigger>
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
