'use client';

import { useLobbyVoice, ConnectionState } from './LobbyVoiceProvider';
import { LobbyVoiceView } from './LobbyVoiceView';
import { LobbyDmView } from './LobbyDmView';
import { LobbyActivityView } from './LobbyActivityView';
import { LobbyLiveRoster } from './LobbyLiveRoster';
import { LobbyComposer } from './LobbyComposer';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import type { LobbyAdminLinks } from '@/lib/admin-sections';
import { BotAvatar, BotBadge } from './BotIdentity';
import { WebhookAvatar, WebhookBadge } from './WebhookIdentity';
import { InteractionAnnouncer, InteractionHeader } from './slash/InteractionRows';
import { useUserInteractionFeed } from './slash/useUserInteractionFeed';
import { useEffect, useMemo, useState } from 'react';

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
  createdAt: string;
  body: string;
  attachment?: { name: string; size: string };
  blocked?: boolean;
  pinned?: boolean;
  /** Set when a bot wrote the message — rendered with the BOT badge. */
  bot?: { id: string | null; name: string; type: string } | null;
  /** A bot's answer to a slash command: "↳ <user> used /<command>". */
  interaction?: { id: string; commandName: string; invokedBy: { id: string | null; name: string | null } } | null;
  /** Posted by an incoming channel webhook — rendered with the WEBHOOK badge. */
  webhook?: { id: string | null; name: string; displayName: string } | null;
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
  /** Settings links resolved for this viewer (null: draw no control). */
  adminLinks: Pick<LobbyAdminLinks, 'appSettings'>;
  canStartActivities?: boolean;
  installedApps: Array<{
    id: string;
    name: string;
    summary: string | null;
    minPlayers: number | null;
    maxPlayers: number | null;
    trustLevel: string | null;
    sandboxed?: boolean;
  }>;
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
  const t = useT();
  const voice = useLobbyVoice();
  // Ephemeral bot answers reach this member on their own topic, whatever
  // the centre column is showing.
  useUserInteractionFeed(data.isLive ? data.currentUserId : null);
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
  const voiceChannelName = data.voiceChannels.find((c) => c.id === voice.activeChannelId)?.name ?? t('lobbyMain.voice.fallbackName');
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
  const composerChannels = useMemo(
    () => [...data.textChannels, ...data.voiceChannels],
    [data.textChannels, data.voiceChannels]
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

  // The centre column is the single work surface: a conversation or the
  // activities hub takes it over instead of navigating away from the
  // lobby and throwing out the channel list, roster and voice controls.
  if (voice.mainViewMode === 'dm' && voice.activeDm) {
    return (
      <LobbyDmView
        dm={voice.activeDm}
        currentUserId={data.currentUserId}
        currentDisplayName={data.currentDisplayName}
      />
    );
  }

  if (voice.mainViewMode === 'activity' && voice.activeActivityChannel && data.serverId) {
    return (
      <LobbyActivityView
        serverId={data.serverId}
        channelId={voice.activeActivityChannel.channelId}
        channelName={voice.activeActivityChannel.channelName}
        apps={data.installedApps}
        currentUserId={data.currentUserId}
        appSettingsHref={data.adminLinks.appSettings}
        canStartActivities={data.canStartActivities ?? false}
      />
    );
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
        onOpenActivities={(channelId) =>
          voice.openActivities({
            channelId,
            channelName:
              data.voiceChannels.find((c) => c.id === channelId)?.name
              ?? t('lobbyMain.channel.thisRoom'),
          })
        }
      />
      <MessagesArea data={data} activeChannelId={activeChannelId} channelName={channelName} searchQuery={searchQuery} showPinned={showPinned} />
      <LobbyComposer
        channelName={channelName}
        serverId={data.serverId}
        channelId={activeChannelId}
        live={data.isLive}
        members={memberMentions}
        channels={composerChannels}
      />
      <InteractionAnnouncer />
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
      <LobbyComposer
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
  onOpenActivities,
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
  onOpenActivities?: (channelId: string) => void;
}) {
  const t = useT();
  return (
    <header className="h-16 pl-16 pr-6 md:pl-6 flex items-center justify-between border-b border-border-subtle bg-surface-dim/80 backdrop-blur-md z-10 sticky top-0 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[24px] text-text-secondary">tag</span>
        <h2 className="font-body-lg font-bold text-text-primary">{channelName}</h2>
        <div className="h-4 w-[1px] bg-border-subtle mx-2" />
        <p className="font-label-sm hidden md:block text-text-secondary">
          {t('lobbyMain.channel.topic')}
        </p>
      </div>
      <div className="flex items-center gap-4">
        {/* Opens the activities hub in the centre column — it used to
            navigate to the developer-facing /room page. */}
        {serverId && voiceChannelId ? (
          <button
            type="button"
            onClick={() => onOpenActivities?.(voiceChannelId)}
            title={t('lobbyMain.channel.activitiesTitle')}
            className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">stadia_controller</span>
            <span className="hidden sm:inline">{t('lobbyMain.activities.title')}</span>
          </button>
        ) : null}
        <button type="button" onClick={onToggleNotifications} title={notificationsMuted ? t('lobbyMain.channel.notificationsEnable') : t('lobbyMain.channel.notificationsMute')} className={notificationsMuted ? 'text-danger hover:text-danger/80' : 'hover:text-text-primary transition-colors text-text-secondary'}>
          <span className="material-symbols-outlined">{notificationsMuted ? 'notifications_off' : 'notifications'}</span>
        </button>
        <button type="button" onClick={onTogglePinned} aria-pressed={showPinned} title={showPinned ? t('lobbyMain.channel.showAll') : t('lobbyMain.channel.showPinned')} className={showPinned ? 'text-primary' : 'hover:text-text-primary transition-colors text-text-secondary'}>
          <span className="material-symbols-outlined">push_pin</span>
        </button>
        <div className="relative hidden lg:block w-48">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-text-secondary">search</span>
          <input
            className="w-full bg-surface-container border border-border-subtle rounded-md py-1 pl-8 pr-2 text-label-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            placeholder={t('lobbyMain.channel.search')}
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
    // Members too: the "↳ <user> used /<command>" header names whoever ran
    // the command, who need not have written anything in the loaded window.
    for (const member of data.members ?? []) names[member.id] = member.name;
    for (const m of data.messages) if (m.authorId) names[m.authorId] = m.author;
    return names;
  }, [data.currentUserId, data.currentDisplayName, data.messages, data.members]);

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
  const t = useT();
  if (message.blocked) {
    return (
      <div className="flex gap-4 group p-2 -mx-2 rounded-lg opacity-50">
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
    <div data-chat-message data-bot-message={message.bot ? 'true' : undefined} data-webhook-message={message.webhook ? 'true' : undefined} className="flex gap-4 group hover:bg-surface-container/30 p-2 -mx-2 rounded-lg transition-colors">
      {message.bot ? (
        <BotAvatar size="md" className="mt-1" />
      ) : message.webhook ? (
        <WebhookAvatar className="mt-1" />
      ) : (
        <div data-chat-avatar className="chat-avatar w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center font-bold text-text-primary">
          {initialOf(message.author, { locale: t.locale })}
        </div>
      )}
      <div className="flex flex-col w-full min-w-0">
        {message.bot && message.interaction ? (
          <InteractionHeader
            user={message.interaction.invokedBy.name ?? t('lobbyMain.chat.unknownUser')}
            command={message.interaction.commandName}
          />
        ) : null}
        <div className="flex items-baseline gap-2">
          <span className={`font-label-sm font-medium ${authorColorClass} hover:underline cursor-pointer`}>{message.author}</span>
          {message.bot ? <BotBadge className="self-center" /> : message.webhook ? <WebhookBadge className="self-center" /> : null}
          <span className="font-label-xs text-[11px] text-text-secondary">{message.timestamp}</span>
        </div>
        <p className="font-body-md text-text-secondary mt-1 whitespace-pre-wrap">{message.body}</p>
      </div>
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
