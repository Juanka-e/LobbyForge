import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getSessionSecret } from '@/lib/api-auth';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import {
  getEffectiveInstanceAccessSettings,
  getInstanceBootstrapStatus,
  listServersForUser,
  ensureServerMembership,
  seedDefaultRoles,
} from '@lobbyforge/db';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  listChannelsForServer,
  createChannel,
  listMemberSummariesForServer,
  listMessagesForChannel,
  getUserById,
  getBlockedUserIds,
  getUserPermissions,
  type ChannelRow,
  type ChannelType,
  type MemberSummary,
  type MessageRow,
} from '@lobbyforge/db';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getUserPresenceInChannel, getUserPresenceInServer, setUserPresence } from '@/lib/redis';
import { LobbyVoiceProvider } from './LobbyVoiceProvider';
import { LobbyVoiceChannels } from './LobbyVoiceChannels';
import { LobbyVoiceFooter } from './LobbyVoiceFooter';
import { LobbyTextChannels } from './LobbyTextChannels';
import { LobbyMainArea } from './LobbyMainArea';
import { LobbyMembersClient } from './LobbyMembersClient';
import { BlockListProvider } from './BlockListProvider';
import { isLobbyDemoAllowed } from '@/lib/lobby-mode';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Standalone Lobby - LobbyForge',
  description: 'Your self-hosted community in a single 1280px window.',
};

// ---- Shared types ----

type ChannelCategory = 'text' | 'voice';
interface Channel {
  id: string;
  name: string;
  category: ChannelCategory;
}
interface VoiceUser {
  id: string;
  name: string;
  speaking?: boolean;
  muted?: boolean;
}
interface Member {
  id: string;
  name: string;
  status: 'in-voice' | 'online' | 'offline';
  muted?: boolean;
  grayscale?: boolean;
  roleName?: string | null;
  roleColor?: string | null;
  roleIcon?: string | null;
  statusText?: string | null;
  bio?: string | null;
  roles?: Array<{ id: string; name: string; color: string | null; icon: string | null; position: number; displaySeparately: boolean }>;
  isGuest?: boolean;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
}
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
interface LobbyData {
  serverName: string;
  serverId: string | null;
  /** All servers the user has joined — drives the ServerRail switcher.
   * Empty in demo mode. */
  joinedServers: Array<{ id: string; name: string }>;
  textChannels: Channel[];
  voiceChannels: Channel[];
  activeTextChannel: Channel | null;
  activeVoiceChannel: Channel | null;
  voiceUsers: VoiceUser[];
  voiceUsersByChannel: Record<string, VoiceUser[]>;
  members: Member[];
  messages: ChatMessage[];
  currentUserId: string | null;
  /** Display name of the local user (resolved from DB) - used by the
   * LiveKit voice provider to send as `name` and to label "you" in the
   * participant roster instead of the LiveKit identity (which is the
   * raw UUID). */
  currentDisplayName: string;
  /** True when this view is backed by live DB/Redis data. */
  isLive: boolean;
  canManageMessages: boolean;
}

// ---- Demo fallback (preserves the M19 standalone lobby visual reference) ----
// Used only when the visitor is unauthenticated OR has no server yet. The
// moment `listServersForUser` returns a row, we switch to live data below.

const DEMO_CHANNELS: Channel[] = [
  { id: 'announcements', name: 'announcements', category: 'text' },
  { id: 'general', name: 'general', category: 'text' },
  { id: 'clips', name: 'clips', category: 'text' },
  { id: 'main-lounge', name: 'Main Lounge', category: 'voice' },
  { id: 'game-room-1', name: 'Game Room 1', category: 'voice' },
  { id: 'hushle-room', name: 'Hushle Room', category: 'voice' },
  { id: 'vampire-night', name: 'Vampire Night', category: 'voice' },
];
const DEMO_VOICE_USERS: VoiceUser[] = [
  { id: 'juanka', name: 'juanka', speaking: true },
  { id: 'ayse', name: 'Ayse' },
  { id: 'mehmet', name: 'Mehmet', muted: true },
];
const DEMO_MEMBERS: Member[] = [
  { id: 'juanka', name: 'juanka', status: 'in-voice' },
  { id: 'ayse', name: 'Ayse', status: 'in-voice' },
  { id: 'mehmet', name: 'Mehmet', status: 'in-voice', muted: true },
  { id: 'lina', name: 'Lina', status: 'online' },
  { id: 'ozan', name: 'Ozan_TR', status: 'offline', grayscale: true },
];
const DEMO_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    authorId: 'ozan',
    author: 'Ozan_TR',
    timestamp: 'Yesterday at 11:42 PM',
    body: 'Thanks for setting up the new server instance. Audio quality seems much more stable on LobbyForge infrastructure compared to our old setup.',
  },
  {
    id: 'm2',
    authorId: 'lina',
    author: 'Lina',
    authorColor: 'primary',
    timestamp: 'Today at 8:15 AM',
    body: 'I pushed the latest server logs to the repo. Latency graphs are looking solid.',
    attachment: { name: 'server_latency_report_v2.pdf', size: '1.2 MB' },
  },
  {
    id: 'm3',
    authorId: 'juanka',
    author: 'juanka',
    timestamp: 'Today at 10:30 AM',
    body: "Anyone jumping into Voice soon? I'm hanging out in the Main Lounge testing mic levels.",
  },
];

// ---- Helpers for building LobbyData from live rows ----

function toCategory(type: ChannelType): ChannelCategory {
  return type === 'voice' || type === 'stage' ? 'voice' : 'text';
}

function formatTimestamp(d: Date): string {
  try {
    return d.toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return d.toISOString();
  }
}

function buildMembers(
  summaries: MemberSummary[],
  serverPresence: Array<{ userId: string; channelId: string; status?: string }>,
  voiceChannelIds: Set<string>
): Member[] {
  const presenceByUser = new Map<string, { channelId: string; status?: string }>();
  for (const p of serverPresence) presenceByUser.set(p.userId, p);
  return summaries
    .map((s) => {
      const p = presenceByUser.get(s.userId);
      let status: Member['status'] = 'offline';
      if (p) {
        status = p.channelId && voiceChannelIds.has(p.channelId) ? 'in-voice' : 'online';
      }
      const highestRole = s.roles.find((role) => role.name !== '@everyone');
      return {
        id: s.userId,
        name: s.displayName,
        status,
        grayscale: status === 'offline' || undefined,
        roleName: highestRole?.name ?? (s.roleName === '@everyone' ? null : s.roleName),
        roleColor: highestRole?.color ?? s.roleColor,
        roleIcon: highestRole?.icon ?? s.roleIcon,
        statusText: s.statusText,
        bio: s.bio,
        roles: s.roles,
        isGuest: s.isGuest,
        avatarUrl: s.avatarUrl,
        bannerUrl: s.bannerUrl,
      } satisfies Member;
    })
    .sort((a, b) => {
      const order: Record<Member['status'], number> = { 'in-voice': 0, online: 1, offline: 2 };
      return order[a.status] - order[b.status] || a.name.localeCompare(b.name);
    });
}

function buildVoiceUsers(
  channelPresence: Array<{ userId: string; status?: string }>,
  summaries: MemberSummary[]
): VoiceUser[] {
  const nameByUser = new Map<string, string>();
  for (const s of summaries) nameByUser.set(s.userId, s.displayName);
  return channelPresence.map((p) => ({
    id: p.userId,
    name: nameByUser.get(p.userId) ?? 'User',
  }));
}

function buildVoiceUsersByChannel(
  serverPresence: Array<{ userId: string; channelId: string; status?: string }>,
  summaries: MemberSummary[],
  voiceChannelIds: Set<string>
): Record<string, VoiceUser[]> {
  const nameByUser = new Map<string, string>();
  for (const s of summaries) nameByUser.set(s.userId, s.displayName);
  const byChannel: Record<string, VoiceUser[]> = {};
  for (const presence of serverPresence) {
    if (!voiceChannelIds.has(presence.channelId)) continue;
    const users = byChannel[presence.channelId] ?? [];
    users.push({
      id: presence.userId,
      name: nameByUser.get(presence.userId) ?? 'User',
    });
    byChannel[presence.channelId] = users;
  }
  return byChannel;
}

function buildMessages(
  rows: MessageRow[],
  authors: Map<string, { displayName: string; avatarUrl: string | null }>,
  currentUserId: string | null,
  blockedIds: Set<string>
): ChatMessage[] {
  // listMessagesForChannel returns newest first; UI uses flex-col-reverse
  // so the visual order is correct. We preserve insertion order here.
  return rows.map((m) => {
    const isBlocked = m.userId ? blockedIds.has(m.userId) : false;
    if (isBlocked) {
      return {
        id: m.id,
        authorId: null,
        author: 'Blocked user',
        timestamp: formatTimestamp(m.createdAt),
        body: '[blocked] This message is hidden because the sender is blocked.',
        blocked: true,
      } satisfies ChatMessage;
    }
    const author = m.userId ? authors.get(m.userId) : null;
    const displayName = author?.displayName ?? 'Deleted User';
    return {
      id: m.id,
      authorId: m.userId,
      author: displayName,
      authorColor: m.userId && m.userId === currentUserId ? 'primary' : 'default',
      timestamp: formatTimestamp(m.createdAt),
      body: m.content,
      pinned: typeof m.metadata.$pinnedAt === 'string',
    } satisfies ChatMessage;
  });
}

async function loadLiveData(
  db: ReturnType<typeof getDb>,
  serverId: string,
  currentUserId: string | null
): Promise<LobbyData | null> {
  const channels: ChannelRow[] = await listChannelsForServer(db, serverId);
  // Don't bail on empty channels — a freshly set-up server may have no
  // channels yet. Return an empty LobbyData so the UI shows empty states
  // ("No voice channels yet", "No messages yet") instead of a hard error.

  // Auto-repair: if the server has zero channels (e.g. created before
  // the default-channel seeding was added to createServer), seed the
  // two defaults now and re-fetch. This is idempotent and keeps existing
  // servers usable without a manual migration.
  if (channels.length === 0) {
    try {
      await createChannel(db, { serverId, name: 'general', type: 'text', position: 0 });
      await createChannel(db, { serverId, name: 'Main Lounge', type: 'voice', position: 1 });
    } catch {
      // Non-fatal — the lobby still renders with empty states.
    }
  }
  // Re-fetch channels after the potential repair.
  const allChannels = channels.length > 0
    ? channels
    : await listChannelsForServer(db, serverId).catch(() => [] as ChannelRow[]);

  const textChannels: Channel[] = [];
  const voiceChannels: Channel[] = [];
  for (const c of allChannels) {
    const cat = toCategory(c.type);
    const row: Channel = { id: c.id, name: c.name, category: cat };
    if (cat === 'text') textChannels.push(row);
    else voiceChannels.push(row);
  }
  const activeTextChannel = textChannels[0] ?? null;
  const activeVoiceChannel = voiceChannels[0] ?? null;

  // Parallel: members, messages (if any text channel), presence (channel + server).
  const memberSummariesP = listMemberSummariesForServer(db, serverId).catch(() => [] as MemberSummary[]);
  const messagesP: Promise<MessageRow[]> = activeTextChannel
    ? listMessagesForChannel(db, activeTextChannel.id, { limit: 50 }).catch(() => [] as MessageRow[])
    : Promise.resolve([]);
  const voicePresenceP = activeVoiceChannel
    ? getUserPresenceInChannel(activeVoiceChannel.id).catch(() => [])
    : Promise.resolve([]);
  const serverPresenceP = getUserPresenceInServer(serverId).catch(() => []);

  const [memberSummaries, messageRows, voicePresence, serverPresence] = await Promise.all([
    memberSummariesP,
    messagesP,
    voicePresenceP,
    serverPresenceP,
  ]);

  // Resolve author display names for the visible message window.
  const authorIds = Array.from(new Set(messageRows.map((m) => m.userId).filter(Boolean))) as string[];
  const authorMap = new Map<string, { displayName: string; avatarUrl: string | null }>();
  for (const member of memberSummaries) {
    authorMap.set(member.userId, { displayName: member.displayName, avatarUrl: member.avatarUrl });
  }
  if (authorIds.length > 0) {
    const missingAuthorIds = authorIds.filter((id) => !authorMap.has(id));
    const users = await Promise.all(missingAuthorIds.map((id) => getUserById(db, id)));
    users.forEach((u, i) => {
      if (u) authorMap.set(missingAuthorIds[i], { displayName: u.displayName, avatarUrl: u.avatarUrl });
    });
  }

  // Mark the current user as "online" in Redis so they appear in the
  // online list immediately. Without this, only voice-channel heartbeats
  // create presence entries — text-only users appear offline to others.
  if (currentUserId) {
    void setUserPresence(currentUserId, serverId, activeTextChannel?.id ?? serverId, 'online', 90).catch(() => {});
  }

  const voiceChannelIds = new Set(voiceChannels.map((c) => c.id));
  const members = buildMembers(memberSummaries, serverPresence, voiceChannelIds);
  const voiceUsers = buildVoiceUsers(voicePresence, memberSummaries);
  const voiceUsersByChannel = buildVoiceUsersByChannel(serverPresence, memberSummaries, voiceChannelIds);

  // Resolve the caller's block list so blocked authors' messages are
  // masked at the server level - the content never reaches the client.
  const blockedIds = currentUserId ? await getBlockedUserIds(db, currentUserId) : new Set<string>();
  const messages = buildMessages(messageRows, authorMap, currentUserId, blockedIds);
  const canManageMessages = currentUserId
    ? hasPermission(await getUserPermissions(db, currentUserId, serverId), CorePermission.MANAGE_MESSAGES)
    : false;

  // Resolve the local user's display name so the LiveKit voice provider
  // can send it as the participant `name` AND so the sidebar voice roster
  // shows the user's real name on the local tile instead of the raw
  // UUID identity (which the token endpoint sets to `session.uid`).
  let currentDisplayName = 'Guest';
  if (currentUserId) {
    const me = await getUserById(db, currentUserId).catch(() => null);
    if (me?.displayName) currentDisplayName = me.displayName;
  }

  return {
    serverName: '', // filled in by caller
    serverId,
    joinedServers: [], // filled in by the caller after listing all servers
    textChannels,
    voiceChannels,
    activeTextChannel,
    activeVoiceChannel,
    voiceUsers,
    voiceUsersByChannel,
    members,
    messages,
    currentUserId,
    currentDisplayName,
    isLive: true,
    canManageMessages,
  };
}

// ---- Page entry ----

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  // Force first-run visitors through the /setup wizard before the
  // lobby tries to read instance / server data. On the official host
  // the central team runs setup out-of-band, so this redirect is
  // skipped for that deployment mode.
  if (!isOfficialDeployment()) {
    const setup = await getInstanceBootstrapStatus(getDb());
    if (!setup.bootstrapComplete) redirect('/setup');
  }

  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? null;
  const isOfficial = isOfficialDeployment();
  const demoAllowed = isLobbyDemoAllowed({
    official: isOfficial,
    nodeEnv: process.env.NODE_ENV,
    demoFlag: process.env.LOBBYFORGE_DEMO_MODE,
  });
  const hasUser = userId !== null;
  if (!isOfficial && !hasUser) redirect('/login');
  const setupStatus = !isOfficial ? await getInstanceBootstrapStatus(getDb()) : null;

  let serverName = isOfficial
    ? 'LobbyForge Hub'
    : process.env.LOBBYFORGE_INSTANCE_NAME?.trim() || 'LobbyForge Community';
  let liveData: LobbyData | null = null;
  let liveDataFailed = false;
  const joinedServerList: Array<{ id: string; name: string }> = [];
  if (hasUser) {
    try {
      const db = getDb();
      let servers = await listServersForUser(db, userId, { limit: 50 });
      if (servers.length === 0 && setupStatus?.firstServerId) {
        const access = await getEffectiveInstanceAccessSettings(db);
        const currentUser = await getUserById(db, userId);
        const canAutoJoin =
          setupStatus.ownerUserId === userId ||
          (access.registrationMode === 'open' &&
            (currentUser?.isGuest !== true || access.guestAccessEnabled));
        if (!canAutoJoin) {
          throw new Error('User has no accessible server and auto-join is disabled by instance policy.');
        }
        await ensureServerMembership(db, setupStatus.firstServerId, userId);
        if (setupStatus.ownerUserId === userId) {
          await seedDefaultRoles(db, setupStatus.firstServerId, userId);
        }
        servers = await listServersForUser(db, userId, { limit: 50 });
      }
      for (const s of servers) {
        joinedServerList.push({ id: s.id, name: s.name });
      }
      // Honor a ?server=<id> selection so the rail can switch communities
      // without client-side state. Falls back to the first (most recent).
      const params = await searchParams;
      const requested = params.server;
      const srv =
        (requested && servers.find((s) => s.id === requested)) || servers[0];
      if (srv?.name) serverName = srv.name;
      if (srv?.id) {
        liveData = await loadLiveData(db, srv.id, userId);
        if (liveData) {
          liveData.serverName = serverName;
          liveData.joinedServers = joinedServerList;
        }
      }
    } catch (error) {
      console.error('[lobby] live data load failed:', (error as Error).name || 'UnknownError');
      liveDataFailed = true;
    }
  }

  if (!demoAllowed && (liveDataFailed || !liveData)) {
    return <LobbyUnavailable reason={liveDataFailed ? 'data_unavailable' : 'server_missing'} />;
  }

  const data: LobbyData = liveData ?? {
    serverName,
    serverId: null,
    joinedServers: [],
    textChannels: DEMO_CHANNELS.filter((c) => c.category === 'text'),
    voiceChannels: DEMO_CHANNELS.filter((c) => c.category === 'voice'),
    activeTextChannel: DEMO_CHANNELS.find((c) => c.category === 'text') ?? null,
    activeVoiceChannel: DEMO_CHANNELS.find((c) => c.category === 'voice') ?? null,
    voiceUsers: DEMO_VOICE_USERS,
    voiceUsersByChannel: {
      [DEMO_CHANNELS.find((c) => c.category === 'voice')?.id ?? 'main-lounge']: DEMO_VOICE_USERS,
    },
    members: DEMO_MEMBERS,
    messages: DEMO_MESSAGES,
    currentUserId: userId,
    currentDisplayName: 'Guest',
    isLive: false,
    canManageMessages: false,
  };

  return (
    <LobbyShell
      serverName={data.serverName}
      isOfficial={isOfficial}
      hasUser={hasUser}
      data={data}
    />
  );
}

function LobbyUnavailable({ reason }: { reason: 'data_unavailable' | 'server_missing' }) {
  return (
    <div className="grid h-dvh w-full place-items-center bg-background p-6">
      <section className="w-full max-w-md text-center">
        <span className="material-symbols-outlined text-4xl text-danger" aria-hidden>cloud_off</span>
        <h1 className="mt-4 text-xl font-semibold text-text-primary">Community unavailable</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          {reason === 'data_unavailable'
            ? 'LobbyForge could not load the community data. No demo members or messages were substituted.'
            : 'This account has no accessible community. An authenticated administrator must repair the server assignment.'}
        </p>
        <Link href="/admin/health" className="mt-5 inline-flex items-center gap-2 rounded-md border border-border-strong px-4 py-2 text-sm text-text-secondary hover:bg-surface-container">
          <span className="material-symbols-outlined text-lg" aria-hidden>health_and_safety</span>
          Open system health
        </Link>
      </section>
    </div>
  );
}

function LobbyShell({
  serverName,
  isOfficial,
  hasUser,
  data,
}: {
  serverName: string;
  isOfficial: boolean;
  hasUser: boolean;
  data: LobbyData;
}) {
  // LiveKit is only wired in live mode - demo mode keeps the legacy
  // SSR-only ChannelGroup + VoiceControlFooter so the demo render path
  // stays server-only (no client island mounts in demo mode).
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? 'ws://localhost:7880';
  const canVoiceConnect = data.isLive && !!data.serverId && hasUser;

  const shell = (
    <>
      <ServerRail
        serverName={serverName}
        isOfficial={isOfficial}
        activeServerId={data.serverId}
        joinedServers={data.joinedServers}
      />
      <Sidebar
        serverName={serverName}
        isOfficial={isOfficial}
        hasUser={hasUser}
        data={data}
        voiceProvider={canVoiceConnect}
      />
      <LobbyMainArea data={data} canVoice={canVoiceConnect} />
      {data.isLive && data.serverId ? (
        <LobbyMembersClient
          serverId={data.serverId}
          initialMembers={data.members}
          voiceChannelIds={data.voiceChannels.map((c) => c.id)}
          currentUserId={data.currentUserId}
        />
      ) : (
        <MembersPanel data={data} />
      )}
    </>
  );

  return (
    <div className="flex w-full h-dvh bg-surface-dim overflow-hidden">
      {canVoiceConnect ? (
        <BlockListProvider>
          <LobbyVoiceProvider
            serverId={data.serverId!}
            livekitUrl={livekitUrl}
            knownNames={buildKnownNames(data)}
            localDisplayName={data.currentDisplayName}
            initialTextChannelId={data.activeTextChannel?.id ?? null}
            initialTextChannelName={data.activeTextChannel?.name ?? 'general'}
          >
            {shell}
          </LobbyVoiceProvider>
        </BlockListProvider>
      ) : (
        shell
      )}
    </div>
  );
}

/**
 * Server rail - the 72px left navigation bar. Lists every community the
 * user has joined so they can switch between them via `?server=<id>`.
 * The active community is highlighted; the rest are muted tiles. An
 * "add community" affordance is shown only on the official deployment
 * (self-host is single-server by design).
 */
function ServerRail({
  serverName,
  isOfficial,
  activeServerId,
  joinedServers,
}: {
  serverName: string;
  isOfficial: boolean;
  activeServerId: string | null;
  joinedServers: Array<{ id: string; name: string }>;
}) {
  return (
    <nav className="w-[72px] h-full bg-background border-r border-border-subtle flex flex-col items-center py-3 flex-shrink-0 z-50 animate-fade-in-right">
      <div className="mb-4">
        <a
          href="/"
          className="w-12 h-12 rounded-2xl bg-surface-container flex items-center justify-center font-bold text-primary hover:rounded-xl hover:scale-105 hover:shadow-[0_0_15px_rgba(143,184,255,0.3)] transition-all duration-300"
          title="LobbyForge Home"
        >
          LF
        </a>
      </div>
      <div className="w-8 h-[2px] bg-border-subtle mb-4" />
      <div className="flex-1 space-y-2 w-full flex flex-col items-center overflow-y-auto">
        {joinedServers.length > 0 ? (
          joinedServers.map((s) => {
            const active = s.id === activeServerId;
            return (
              <div key={s.id} className="relative group">
                {active ? (
                  <div className="absolute -left-1 top-1 w-1 h-10 bg-text-primary rounded-r-full" />
                ) : null}
                <a
                  href={`/lobby?server=${encodeURIComponent(s.id)}`}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-300 ${
                    active
                      ? 'bg-primary text-on-primary hover:scale-105'
                      : 'bg-surface-container text-text-secondary hover:bg-surface-container-high hover:text-text-primary hover:rounded-2xl'
                  }`}
                  title={s.name}
                >
                  <span className="text-sm font-bold">
                    {s.name.charAt(0).toUpperCase()}
                  </span>
                </a>
                <div className="absolute left-16 top-1/2 -translate-y-1/2 px-2 py-1 bg-surface-container-high text-xs rounded opacity-0 rail-tooltip whitespace-nowrap z-[60] border border-border-subtle">
                  {s.name}
                </div>
              </div>
            );
          })
        ) : (
          // Demo / no-server fallback: show the active server name only.
          <div className="relative group">
            <div className="absolute -left-1 top-1 w-1 h-10 bg-text-primary rounded-r-full" />
            <button
              className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary text-on-primary hover:scale-105 transition-all duration-300"
              title={serverName}
            >
              <span className="text-sm font-bold">
                {serverName.charAt(0).toUpperCase()}
              </span>
            </button>
            <div className="absolute left-16 top-1/2 -translate-y-1/2 px-2 py-1 bg-surface-container-high text-xs rounded opacity-0 rail-tooltip whitespace-nowrap z-[60] border border-border-subtle">
              {serverName}
            </div>
          </div>
        )}
        {isOfficial ? (
          <div className="relative group">
            <a
              href="/instances/new"
              className="w-12 h-12 rounded-full flex items-center justify-center text-success border border-dashed border-border-subtle hover:bg-success/10 hover:border-success hover:scale-105 transition-all duration-300"
              title="Add a community"
            >
              <span className="material-symbols-outlined">add</span>
            </a>
            <div className="absolute left-16 top-1/2 -translate-y-1/2 px-2 py-1 bg-surface-container-high text-xs rounded opacity-0 rail-tooltip whitespace-nowrap z-[60] border border-border-subtle">
              Add a community
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-auto space-y-2 flex flex-col items-center">
        <Link
          href="/settings"
          className="w-12 h-12 rounded-full flex items-center justify-center text-text-secondary hover:bg-surface-container hover:text-text-primary transition-all duration-300"
          title="User settings"
        >
          <span className="material-symbols-outlined">settings</span>
        </Link>
      </div>
    </nav>
  );
}

function Sidebar({
  serverName,
  isOfficial,
  hasUser,
  data,
  voiceProvider,
}: {
  serverName: string;
  isOfficial: boolean;
  hasUser: boolean;
  data: LobbyData;
  /** True when the parent LobbyShell wrapped us in <LobbyVoiceProvider>. */
  voiceProvider: boolean;
}) {
  const activeVoiceId = data.activeVoiceChannel?.id;
  return (
    <nav
      className="hidden md:flex w-[240px] lg:w-[260px] flex-shrink-0 bg-surface border-r border-border-subtle flex-col h-full z-20 animate-fade-in-right"
    >
      {/* Server header - community name + "Add instance" CTA on official host */}
      <div className="relative border-b border-border-subtle group/server-menu">
        <button className="h-16 px-4 flex items-center justify-between hover:bg-surface-container transition-colors duration-150 w-full text-left group">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-secondary-container flex items-center justify-center flex-shrink-0 font-bold text-text-primary">
              {serverName.charAt(0).toUpperCase()}
            </div>
            <span className="font-label-sm text-text-primary font-semibold whitespace-nowrap truncate">
              {serverName}
            </span>
          </div>
          <span className="material-symbols-outlined group-hover:text-text-primary transition-colors text-[20px] text-text-secondary">
            expand_more
          </span>
        </button>
        {data.isLive && data.serverId ? (
          <div className="pointer-events-none absolute left-3 right-3 top-[58px] z-50 rounded-lg border border-border-subtle bg-surface-floating p-2 opacity-0 shadow-xl transition-all group-hover/server-menu:pointer-events-auto group-hover/server-menu:opacity-100 group-focus-within/server-menu:pointer-events-auto group-focus-within/server-menu:opacity-100">
            <Link
              href="/admin/settings"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
            >
              <span className="material-symbols-outlined text-[18px]">admin_panel_settings</span>
              Admin panel
            </Link>
            <Link
              href="/admin/settings/channels"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
            >
              <span className="material-symbols-outlined text-[18px]">forum</span>
              Channels
            </Link>
            <Link
              href="/admin/settings/invites"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
            >
              <span className="material-symbols-outlined text-[18px]">link</span>
              Invites
            </Link>
          </div>
        ) : null}
        {isOfficial ? (
          <div className="px-4 pb-3 pt-1 border-t border-border-subtle/60">
            <a
              href="/instances/new"
              className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-primary bg-primary/10 hover:bg-primary/15 border border-primary/20 transition-colors font-label-xs text-label-xs"
            >
              <span
                className="material-symbols-outlined text-[16px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                add
              </span>
              Add instance
            </a>
          </div>
        ) : null}
      </div>

      {/* Scrollable channels list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div className="animate-fade-in-up stagger-1">
          {voiceProvider ? (
            <LobbyTextChannels channels={data.textChannels} />
          ) : (
            <ChannelGroup
              title="Text Channels"
              channels={data.textChannels}
              iconName="tag"
            />
          )}
        </div>
        <div className="animate-fade-in-up stagger-2">
          {voiceProvider ? (
            <LobbyVoiceChannels
              channels={data.voiceChannels}
              initialVoiceUsers={data.voiceUsers}
              initialVoiceUsersByChannel={data.voiceUsersByChannel}
              initialActiveChannelId={activeVoiceId ?? null}
              currentUserId={data.currentUserId}
            />
          ) : (
            <ChannelGroup
              title="Voice Channels"
              channels={data.voiceChannels}
              iconName="volume_up"
              activeChannelId={activeVoiceId}
              voiceUsers={data.voiceUsers}
            />
          )}
        </div>
      </div>

      {/* Voice control + user status footer */}
      {voiceProvider ? (
        <LobbyVoiceFooter serverName={serverName} hasUser={hasUser} />
      ) : (
        <VoiceControlFooter serverName={serverName} hasUser={hasUser} />
      )}
    </nav>
  );
}

/**
 * Build the `identity -> displayName` lookup the voice panel needs to
 * render LiveKit participant identities as human names. The set is
 * seeded from the SSR snapshot (voice users + members + message
 * authors) and kept warm at runtime by `LobbyLiveRoster`'s presence
 * poll. The local user is always seeded with their display name so
 * the local tile in the voice roster doesn't fall back to the raw
 * UUID identity.
 */
function buildKnownNames(data: LobbyData): Record<string, string> {
  const map: Record<string, string> = {};
  if (data.currentUserId) map[data.currentUserId] = data.currentDisplayName;
  for (const v of data.voiceUsers) map[v.id] = v.name;
  for (const m of data.members) map[m.id] = m.name;
  for (const msg of data.messages) if (msg.authorId) map[msg.authorId] = msg.author;
  return map;
}

function ChannelGroup({
  title,
  channels,
  iconName,
  activeChannelId,
  voiceUsers,
}: {
  title: string;
  channels: Channel[];
  iconName: string;
  activeChannelId?: string;
  voiceUsers?: VoiceUser[];
}) {
  if (channels.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2 group cursor-pointer">
        <h3 className="font-label-xs uppercase tracking-wider group-hover:text-text-secondary transition-colors text-text-secondary">
          {title}
        </h3>
        <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
          add
        </span>
      </div>
      <ul className="space-y-[2px]">
        {channels.map((c) => {
          const active = c.id === activeChannelId;
          return (
            <li key={c.id}>
              <button
                className={
                  active
                    ? 'w-full flex items-center justify-between px-2 py-1.5 rounded-md text-text-primary bg-surface-container-high transition-colors group'
                    : 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:text-text-secondary hover:bg-surface-container transition-colors group text-text-secondary'
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      active
                        ? 'material-symbols-outlined text-[18px] text-primary'
                        : 'material-symbols-outlined text-[18px] opacity-70'
                    }
                  >
                    {iconName}
                  </span>
                  <span className="font-label-sm font-medium">{c.name}</span>
                </div>
                {active ? (
                  <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
                    settings
                  </span>
                ) : null}
              </button>
              {active && voiceUsers ? (
                <ul className="ml-6 mt-1 space-y-1 pb-2">
                  {voiceUsers.length === 0 ? (
                    <li className="px-2 py-1 text-label-xs text-text-muted italic">
                      No one here yet
                    </li>
                  ) : null}
                  {voiceUsers.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-surface-container/50 cursor-pointer group"
                    >
                      <div
                        className={
                          u.speaking
                            ? 'w-6 h-6 rounded-full bg-secondary-container relative border-2 border-primary is-speaking'
                            : 'w-6 h-6 rounded-full bg-secondary-container relative'
                        }
                      >
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-text-primary">
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span
                        className={
                          u.speaking
                            ? 'font-label-sm text-text-primary flex-1 truncate'
                            : 'font-label-sm text-text-secondary flex-1 truncate'
                        }
                      >
                        {u.name}
                      </span>
                      {u.muted ? (
                        <span className="material-symbols-outlined text-[14px] text-danger">
                          mic_off
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VoiceControlFooter({ serverName, hasUser }: { serverName: string; hasUser: boolean }) {
  return (
    <div className="mt-auto border-t border-border-subtle bg-surface-raised flex flex-col">
      <div className="bg-surface-container-lowest p-3 border-b border-border-subtle">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-success" />
              <span className="text-[11px] text-success font-bold uppercase tracking-tight">
                Voice {hasUser ? 'Connected' : 'Ready'}
              </span>
            </div>
            <button className="text-[13px] text-text-secondary hover:text-text-primary transition-colors truncate text-left">
              {serverName}
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <button className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors">
              <span className="material-symbols-outlined text-[18px]">videocam</span>
            </button>
            <button className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors">
              <span className="material-symbols-outlined text-[18px]">screen_share</span>
            </button>
            <button className="p-1.5 rounded hover:bg-surface-container text-danger transition-colors">
              <span className="material-symbols-outlined text-[18px]">call_end</span>
            </button>
          </div>
        </div>
      </div>
      <div className="p-3 bg-surface-raised">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full bg-secondary-container relative flex-shrink-0">
              <span className="absolute inset-0 flex items-center justify-center text-label-sm font-bold text-text-primary">
                {hasUser ? 'J' : '?'}
              </span>
              <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-success border-2 border-surface-raised" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[13px] text-text-primary font-medium truncate">
                {hasUser ? 'You' : 'Guest'}
              </span>
              <span className="text-[11px] text-text-secondary">Online</span>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <button className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors">
              <span className="material-symbols-outlined text-[18px]">mic</span>
            </button>
            <button className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors">
              <span className="material-symbols-outlined text-[18px]">headphones</span>
            </button>
            <button className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors">
              <span className="material-symbols-outlined text-[18px]">settings</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function MembersPanel({ data }: { data: LobbyData }) {
  const online = data.members.filter((m) => m.status === 'online' || m.status === 'in-voice');
  const offline = data.members.filter((m) => m.status === 'offline');

  return (
    <aside
      className="w-[200px] lg:w-[230px] flex-shrink-0 bg-surface-dim border-l border-border-subtle hidden lg:flex flex-col h-full z-20 overflow-y-auto p-4 animate-fade-in-left"
    >
      {data.members.length === 0 ? (
        <p className="font-label-xs text-text-muted italic">No members yet.</p>
      ) : null}
        <MemberSection label={`Online - ${online.length}`} members={online} />
        <MemberSection label={`Offline - ${offline.length}`} members={offline} dimmed />
    </aside>
  );
}

function MemberSection({
  label,
  members,
  dimmed,
}: {
  label: string;
  members: Member[];
  dimmed?: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <div className="mb-6">
      <h3
        className={
          dimmed
            ? 'font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 opacity-70 text-text-secondary'
            : 'font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 text-text-secondary'
        }
      >
        <span>{label}</span>
        <div className="h-[1px] flex-1 bg-border-subtle" />
      </h3>
      <ul className={dimmed ? 'space-y-1 opacity-60' : 'space-y-1'}>
        {members.map((m) => (
          <li key={m.id}>
            <div className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-container/50 cursor-pointer group opacity-80">
              <div className="w-8 h-8 rounded-full bg-secondary-container relative flex-shrink-0 overflow-hidden">
                <span className="absolute inset-0 flex items-center justify-center text-label-sm font-bold text-text-primary">
                  {m.name.charAt(0).toUpperCase()}
                </span>
                {m.status !== 'offline' ? (
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-surface-dim" />
                ) : (
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-surface-container border-2 border-surface-dim flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                  </div>
                )}
              </div>
              <span className="font-label-sm text-text-secondary truncate flex-1">{m.name}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

