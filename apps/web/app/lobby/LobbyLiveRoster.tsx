'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';

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
  body: string;
  attachment?: { name: string; size: string };
  blocked?: boolean;
  pinned?: boolean;
}

interface WsChatEnvelope {
  type: 'message';
  message: {
    id: string;
    channelId: string;
    userId: string;
    content: string;
    createdAt: string;
  };
  at: string;
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

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function LobbyLiveRoster({ data, searchQuery = '', showPinned = false }: { data: LobbyLiveRosterData; searchQuery?: string; showPinned?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>(data.initialMessages);
  const nameCacheRef = useRef<Map<string, string>>(new Map(Object.entries(data.knownNames)));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const notificationPrefsRef = useRef({ level: 'mentions', desktopEnabled: true, showPreview: true, sound: 'default' });

  // Sync name cache when knownNames prop changes (parent re-render with new data).
  useEffect(() => {
    for (const [k, v] of Object.entries(data.knownNames)) nameCacheRef.current.set(k, v);
  }, [data.knownNames]);

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
        const body = (await res.json()) as { messages?: Array<{ id: string; userId: string | null; content: string; createdAt: string; metadata?: Record<string, unknown>; blocked?: boolean }> };
        if (cancelled || !body.messages) return;
        setMessages(body.messages.map((message) => ({
          id: message.id,
          authorId: message.userId,
          author: message.blocked ? 'Blocked user' : message.userId ? (nameCacheRef.current.get(message.userId) ?? 'User') : 'Deleted User',
          authorColor: message.userId === data.currentUserId ? 'primary' : 'default',
          timestamp: formatTimestamp(message.createdAt),
          body: message.content,
          blocked: message.blocked,
          pinned: typeof message.metadata?.$pinnedAt === 'string',
        })));
      } catch {
        // Realtime/local echo can continue from the current snapshot.
      }
    }
    void loadMessages();
    return () => { cancelled = true; };
  }, [data.channelId, data.currentUserId, data.serverId]);

  // ---- Chat WS subscribe ----
  useEffect(() => {
    const topic = `chat:${data.serverId}:${data.channelId}` as const;
    const rc = getRealtimeClient();
    const unsubscribe = rc.subscribe<WsChatEnvelope>(topic, (env) => {
      if (!env || env.type !== 'message' || !env.message) return;
      const m = env.message;
      const author = nameCacheRef.current.get(m.userId) ?? 'User';
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        const next: ChatMessage = {
          id: m.id,
          authorId: m.userId,
          author,
          authorColor: m.userId === data.currentUserId ? 'primary' : 'default',
          timestamp: formatTimestamp(m.createdAt),
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
        new Notification(`${author} in #${data.channelName}`, {
          body: prefs.showPreview ? m.content : 'New message',
          silent: prefs.sound === 'none',
          tag: `lf-message:${data.channelId}`,
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, [data.serverId, data.channelId, data.channelName, data.currentUserId]);

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
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        const author = m.userId ? (nameCacheRef.current.get(m.userId) ?? 'You') : 'Deleted User';
        const next: ChatMessage = {
          id: m.id,
          authorId: m.userId,
          author,
          authorColor: m.userId === data.currentUserId ? 'primary' : 'default',
          timestamp: formatTimestamp(m.createdAt),
          body: m.content,
        };
        return [next, ...prev];
      });
    }
    window.addEventListener('lf-message-sent', onMessageSent as EventListener);
    return () => window.removeEventListener('lf-message-sent', onMessageSent as EventListener);
  }, [data.channelId, data.currentUserId]);

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
          nameCacheRef.current.set(p.userId, 'User');
        }
      }
    } catch {
      // Network/endpoint hiccups are fine — next poll will retry.
    }
  }, [data.serverId, data.voiceChannelId]);

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

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-6 flex flex-col-reverse">
      {visibleMessages.length === 0 ? (
        <p className="font-body-md text-text-muted italic">
          {showPinned
            ? 'No pinned messages in this channel.'
            : normalizedSearch
              ? 'No messages match your search.'
              : 'No messages yet. Be the first to say something.'}
        </p>
      ) : null}
      {visibleMessages.map((m) => (
        <LiveMessage key={m.id} message={m} currentUserId={data.currentUserId} serverId={data.serverId} channelId={data.channelId} canManageMessages={data.canManageMessages} onPinnedChange={(pinned) => setMessages((current) => current.map((item) => item.id === m.id ? { ...item, pinned } : item))} />
      ))}
      {typers.length > 0 ? (
        <div className="px-2 py-1 flex items-center gap-2 text-xs text-text-muted animate-fade-in-up">
          <div className="flex gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.15s' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0.3s' }} />
          </div>
          <span>
            {typers.length === 1
              ? `${typers[0]} is typing...`
              : typers.length === 2
                ? `${typers[0]} and ${typers[1]} are typing...`
                : `${typers[0]} and ${typers.length - 1} others are typing...`}
          </span>
        </div>
      ) : null}
      <ChannelWelcome channelName={data.channelName} />
    </div>
  );
}

function LiveMessage({ message, currentUserId, serverId, channelId, canManageMessages, onPinnedChange }: { message: ChatMessage; currentUserId: string | null; serverId: string; channelId: string; canManageMessages: boolean; onPinnedChange: (pinned: boolean) => void }) {
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
          <span className="font-label-sm font-medium text-text-muted">Blocked user</span>
          <p className="font-body-md text-text-muted mt-1 italic">{message.body}</p>
        </div>
      </div>
    );
  }
  const authorColorClass = message.authorColor === 'primary' ? 'text-primary' : 'text-text-primary';
  return (
    <div data-chat-message className="flex gap-4 group hover:bg-surface-container/30 p-2 -mx-2 rounded-lg transition-colors animate-fade-in-up relative">
      <div data-chat-avatar className="chat-avatar w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center font-bold text-text-primary">
        {message.author.charAt(0).toUpperCase()}
      </div>
      <div className="flex flex-col w-full">
        <div className="flex items-baseline gap-2">
          <span className={`font-label-sm font-medium ${authorColorClass}`}>{message.author}</span>
          <span className="font-label-xs text-[11px] text-text-secondary">{message.timestamp}</span>
          {message.pinned ? <span className="material-symbols-outlined text-[13px] text-primary" title="Pinned">push_pin</span> : null}
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
            <button onClick={saveEdit} className="text-xs px-2 py-1 bg-primary-container text-[#07101e] rounded font-medium">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary">Cancel</button>
          </div>
        ) : (
          <p className="font-body-md text-text-secondary mt-1 whitespace-pre-wrap">{message.body}</p>
        )}
      </div>
      {/* Hover action menu — only for own messages */}
      {(isOwn || canManageMessages) && !editing ? (
        <div className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-surface-raised rounded-md border border-border-subtle shadow-sm">
          {canManageMessages ? <button
            type="button"
            onClick={() => void togglePinned()}
            title={message.pinned ? 'Unpin' : 'Pin'}
            className={message.pinned ? 'p-1 text-primary' : 'p-1 text-text-secondary hover:text-primary'}
          >
            <span className="material-symbols-outlined text-[16px]">push_pin</span>
          </button> : null}
          {isOwn ? <button
            type="button"
            onClick={() => { setEditing(true); setEditValue(message.body); }}
            title="Edit"
            className="p-1 text-text-secondary hover:text-text-primary"
          >
            <span className="material-symbols-outlined text-[16px]">edit</span>
          </button> : null}
          <button
            type="button"
            onClick={deleteMessage}
            title="Delete"
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
  return (
    <div className="py-12 flex flex-col items-start border-b border-border-subtle/30 mb-4">
      <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-[32px] text-text-primary">tag</span>
      </div>
      <h1 className="font-section-h2-mobile text-text-primary mb-2">
        Welcome to #{channelName}!
      </h1>
      <p className="font-body-md text-text-secondary">
        This is the start of the #{channelName} channel. Keep discussions focused and respectful.
      </p>
    </div>
  );
}
