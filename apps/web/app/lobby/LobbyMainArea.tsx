'use client';

import { useLobbyVoice, ConnectionState } from './LobbyVoiceProvider';
import { LobbyVoiceView } from './LobbyVoiceView';
import { LobbyLiveRoster } from './LobbyLiveRoster';
import { MentionInput, type MentionUser } from './MentionInput';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

/**
 * LobbyMainArea — entry point. Splits into Live or Demo based on canVoice
 * to avoid calling useLobbyVoice() conditionally (React Rules of Hooks).
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

interface Channel {
  id: string;
  name: string;
  category: 'text' | 'voice';
}

interface LobbyData {
  serverName: string;
  serverId: string | null;
  textChannels: Channel[];
  voiceChannels: Channel[];
  activeTextChannel: Channel | null;
  activeVoiceChannel: Channel | null;
  currentUserId: string | null;
  currentDisplayName: string;
  messages: ChatMessage[];
  isLive: boolean;
  canManageMessages: boolean;
  members?: Array<{
    id: string;
    name: string;
    roleName?: string | null;
    roleColor?: string | null;
    avatarUrl?: string | null;
    isGuest?: boolean;
  }>;
}

export function LobbyMainArea({ data, canVoice }: { data: LobbyData; canVoice: boolean }) {
  if (canVoice) {
    return <LobbyMainAreaLive data={data} />;
  }
  return <LobbyMainAreaDemo data={data} />;
}

/** Live mode — inside LobbyVoiceProvider, can safely use useLobbyVoice(). */
function LobbyMainAreaLive({ data }: { data: LobbyData }) {
  const voice = useLobbyVoice();
  const [searchQuery, setSearchQuery] = useState('');
  const [showPinned, setShowPinned] = useState(false);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  const connected = voice.connectionState === ConnectionState.Connected && !!voice.activeChannelId;
  // Use the provider's active text channel (switchable from sidebar) or
  // fall back to the SSR-provided one.
  const activeTextChannel = data.textChannels.find((c) => c.id === voice.activeTextChannelId)
    ?? data.activeTextChannel;
  const channelName = activeTextChannel?.name ?? voice.activeTextChannelName ?? 'general';
  const activeChannelId = activeTextChannel?.id ?? voice.activeTextChannelId;
  const voiceChannelName = data.voiceChannels.find((c) => c.id === voice.activeChannelId)?.name ?? 'Voice';
  const memberMentions = useMemo(
    () =>
      (data.members ?? []).map((m) => ({
        userId: m.id,
        displayName: m.name,
        roleName: m.roleName,
        roleColor: m.roleColor,
        avatarUrl: m.avatarUrl,
      })),
    [data.members]
  );

  useEffect(() => {
    if (!activeChannelId) return;
    try {
      setNotificationsMuted(window.localStorage.getItem(`lf-channel-muted:${activeChannelId}`) === 'true');
    } catch {
      setNotificationsMuted(false);
    }
  }, [activeChannelId]);

  function toggleChannelNotifications() {
    setNotificationsMuted((current) => {
      const next = !current;
      if (activeChannelId) {
        try { window.localStorage.setItem(`lf-channel-muted:${activeChannelId}`, String(next)); } catch { /* local preference */ }
      }
      return next;
    });
  }

  if (connected && voice.mainViewMode === 'voice' && voice.activeChannelId) {
    return (
      <main className="flex-1 flex flex-col bg-background min-w-0 relative animate-fade-in-up">
        <LobbyVoiceView channelId={voice.activeChannelId} channelName={voiceChannelName} />
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-background min-w-0 relative text-[14px] animate-fade-in-up">
      <ChannelHeader
        channelName={channelName}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        showPinned={showPinned}
        onTogglePinned={() => setShowPinned((value) => !value)}
        notificationsMuted={notificationsMuted}
        onToggleNotifications={toggleChannelNotifications}
        serverId={data.serverId}
        voiceChannelId={voice.activeChannelId ?? data.activeVoiceChannel?.id ?? null}
      />
      <MessagesArea data={data} activeChannelId={activeChannelId} channelName={channelName} searchQuery={searchQuery} showPinned={showPinned} />
      <Composer
        channelName={channelName}
        serverId={data.serverId}
        channelId={activeChannelId}
        live={data.isLive}
        members={memberMentions}
      />
    </main>
  );
}

/** Demo mode — no voice provider, no hooks violations. */
function LobbyMainAreaDemo({ data }: { data: LobbyData }) {
  const channelName = data.activeTextChannel?.name ?? 'general';
  const [searchQuery, setSearchQuery] = useState('');
  const [showPinned, setShowPinned] = useState(false);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  return (
    <main className="flex-1 flex flex-col bg-background min-w-0 relative text-[14px] animate-fade-in-up">
      <ChannelHeader channelName={channelName} searchQuery={searchQuery} onSearchChange={setSearchQuery} showPinned={showPinned} onTogglePinned={() => setShowPinned((value) => !value)} notificationsMuted={notificationsMuted} onToggleNotifications={() => setNotificationsMuted((value) => !value)} serverId={data.serverId} voiceChannelId={data.activeVoiceChannel?.id ?? null} />
      <MessagesArea data={data} activeChannelId={data.activeTextChannel?.id ?? null} channelName={channelName} searchQuery={searchQuery} showPinned={showPinned} />
      <Composer
        channelName={channelName}
        serverId={data.serverId}
        channelId={data.activeTextChannel?.id ?? null}
        live={data.isLive}
        members={[]}
      />
    </main>
  );
}

function ChannelHeader({
  channelName,
  searchQuery,
  onSearchChange,
  showPinned,
  onTogglePinned,
  notificationsMuted,
  onToggleNotifications,
  serverId,
  voiceChannelId,
}: {
  channelName: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  showPinned: boolean;
  onTogglePinned: () => void;
  notificationsMuted: boolean;
  onToggleNotifications: () => void;
  serverId: string | null;
  voiceChannelId: string | null;
}) {
  return (
    <header className="h-16 px-6 flex items-center justify-between border-b border-border-subtle bg-surface-dim/80 backdrop-blur-md z-10 sticky top-0 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[24px] text-text-secondary">tag</span>
        <h2 className="font-body-lg font-bold text-text-primary">{channelName}</h2>
        <div className="h-4 w-[1px] bg-border-subtle mx-2" />
        <p className="font-label-sm hidden md:block text-text-secondary">
          Welcome to your community. Keep it clean and professional.
        </p>
      </div>
      <div className="flex items-center gap-4">
        {/* Start Activity — links to the /room page where ActivityPicker lives */}
        {serverId && voiceChannelId ? (
          <a
            href={`/room/${voiceChannelId}?serverId=${serverId}&channelId=${voiceChannelId}`}
            title="Start a game or activity in this voice room"
            className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">stadia_controller</span>
            <span className="hidden sm:inline">Activities</span>
          </a>
        ) : null}
        <button type="button" onClick={onToggleNotifications} title={notificationsMuted ? 'Enable channel notifications' : 'Mute channel notifications'} className={notificationsMuted ? 'text-danger hover:text-danger/80' : 'hover:text-text-primary transition-colors text-text-secondary'}>
          <span className="material-symbols-outlined">{notificationsMuted ? 'notifications_off' : 'notifications'}</span>
        </button>
        <button type="button" onClick={onTogglePinned} aria-pressed={showPinned} title={showPinned ? 'Show all messages' : 'Show pinned messages'} className={showPinned ? 'text-primary' : 'hover:text-text-primary transition-colors text-text-secondary'}>
          <span className="material-symbols-outlined">push_pin</span>
        </button>
        <div className="relative hidden lg:block w-48">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-text-secondary">search</span>
          <input
            className="w-full bg-surface-container border border-border-subtle rounded-md py-1 pl-8 pr-2 text-label-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            placeholder="Search"
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      </div>
    </header>
  );
}

function MessagesArea({ data, activeChannelId, channelName, searchQuery, showPinned }: { data: LobbyData; activeChannelId: string | null; channelName: string; searchQuery: string; showPinned: boolean }) {
  const knownNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (data.currentUserId) names[data.currentUserId] = data.currentDisplayName;
    for (const m of data.messages) if (m.authorId) names[m.authorId] = m.author;
    return names;
  }, [data.currentUserId, data.currentDisplayName, data.messages]);

  // When switching channels, we show the SSR messages for the initial
  // channel, and for other channels we show a loading state until the
  // LobbyLiveRoster's WS subscription picks up new messages. In a future
  // iteration, we'd fetch messages for the newly selected channel here.
  if (data.isLive && data.serverId && activeChannelId) {
    // Only pass SSR messages if the active channel matches the SSR one.
    const isInitialChannel = activeChannelId === data.activeTextChannel?.id;
    return (
      <LobbyLiveRoster
        key={activeChannelId}
        data={{
          serverId: data.serverId,
          channelId: activeChannelId,
          channelName,
          currentUserId: data.currentUserId,
          voiceChannelId: null,
          initialMessages: isInitialChannel ? data.messages : [],
          knownNames,
          canManageMessages: data.canManageMessages,
        }}
        searchQuery={searchQuery}
        showPinned={showPinned}
      />
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6 flex flex-col-reverse">
      {data.messages.filter((message) => (!showPinned || message.pinned) && (!searchQuery.trim() || `${message.author} ${message.body}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))).map((m) => (
        <Message key={m.id} message={m} />
      ))}
      <ChannelWelcome channelName={data.activeTextChannel?.name ?? 'general'} />
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.blocked) {
    return (
      <div className="flex gap-4 group p-2 -mx-2 rounded-lg opacity-50">
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
    <div data-chat-message className="flex gap-4 group hover:bg-surface-container/30 p-2 -mx-2 rounded-lg transition-colors">
      <div data-chat-avatar className="chat-avatar w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center font-bold text-text-primary">
        {message.author.charAt(0).toUpperCase()}
      </div>
      <div className="flex flex-col w-full">
        <div className="flex items-baseline gap-2">
          <span className={`font-label-sm font-medium ${authorColorClass} hover:underline cursor-pointer`}>{message.author}</span>
          <span className="font-label-xs text-[11px] text-text-secondary">{message.timestamp}</span>
        </div>
        <p className="font-body-md text-text-secondary mt-1 whitespace-pre-wrap">{message.body}</p>
      </div>
    </div>
  );
}

function ChannelWelcome({ channelName }: { channelName: string }) {
  return (
    <div className="py-12 flex flex-col items-start border-b border-border-subtle/30 mb-4">
      <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-[32px] text-text-primary">tag</span>
      </div>
      <h1 className="font-section-h2-mobile text-text-primary mb-2">Welcome to #{channelName}!</h1>
      <p className="font-body-md text-text-secondary">
        This is the start of the #{channelName} channel. Keep discussions focused and respectful.
      </p>
    </div>
  );
}

function Composer({
  channelName,
  serverId,
  channelId,
  live,
  members,
}: {
  channelName: string;
  serverId: string | null;
  channelId: string | null;
  live: boolean;
  members: MentionUser[];
}) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const lastTypingRef = useRef<number>(0);

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = value.trim();
    if (!content || sending) return;
    if (!live || !serverId || !channelId) {
      setStatus('Messaging is available after joining a live community.');
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
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `Message failed: ${res.status}`);
      }
      const created = (await res.json()) as { message?: { id: string; content: string; userId: string | null; createdAt: string } };
      setValue('');
      setStatus('Sent.');
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

  return (
    <form onSubmit={submit} className="px-6 pb-6 pt-2 bg-background z-10">
      <div className="bg-surface-container-low border border-border-subtle rounded-lg flex items-center px-4 py-2 focus-within:ring-1 focus-within:ring-primary focus-within:border-primary transition-all shadow-sm">
        <button type="button" disabled title="Attachments are not enabled yet" className="w-8 h-8 rounded-full flex items-center justify-center mr-2 text-text-muted opacity-50">
          <span className="material-symbols-outlined text-[20px]">add_circle</span>
        </button>
        <MentionInput
          value={value}
          onChange={(v) => {
            setValue(v);
            if (status === 'Sent.') setStatus(null);
            if (v.trim()) handleTyping();
          }}
          members={members}
          placeholder={`Message #${channelName}`}
          disabled={sending}
        />
        <div className="flex items-center gap-1 ml-2">
          <button type="button" disabled title="Gifts are not enabled yet" className="w-8 h-8 rounded flex items-center justify-center text-text-muted opacity-50">
            <span className="material-symbols-outlined text-[20px]">card_giftcard</span>
          </button>
          <button type="button" disabled title="GIF picker is not enabled yet" className="w-8 h-8 rounded flex items-center justify-center text-text-muted opacity-50">
            <span className="material-symbols-outlined text-[20px]">gif_box</span>
          </button>
          <button type="submit" disabled={!value.trim() || sending} title="Send message" className="w-8 h-8 rounded flex items-center justify-center hover:text-text-primary hover:bg-surface-container transition-colors text-text-secondary disabled:cursor-not-allowed disabled:opacity-40">
            <span className="material-symbols-outlined text-[20px]">send</span>
          </button>
        </div>
      </div>
      {status ? (
        <p className="mt-1 text-xs text-text-muted px-2">{status}</p>
      ) : null}
    </form>
  );
}
