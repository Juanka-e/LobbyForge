# 26 — Client-Side State Management

## Overview

LobbyForge's frontend manages multiple types of state: server data from APIs, real-time presence and voice state, local UI state, and form inputs. This document defines the state management architecture.

## State Categories & Solutions

| Category | Examples | Solution | Why |
|---|---|---|---|
| **Server state** | Servers, channels, members, messages, game sessions | **TanStack Query (React Query)** | Cache, auto-refetch, optimistic updates, pagination, deduplication |
| **Real-time state** | Presence, voice participants, game state, typing | **Zustand** stores + event subscriptions | Mutable, event-driven, needs fast updates without re-renders |
| **UI state** | Modals, sidebars, active panel, theme | **Zustand** | Simple, no boilerplate, persist to localStorage |
| **Form state** | Login, server create, settings, game setup | **React Hook Form + Zod** | Validation, performance (no re-render per keystroke) |
| **URL state** | Active server, channel, search query | **Next.js router (searchParams)** | Shareable, back/forward navigation |

## TanStack Query (Server State)

### Setup

```ts
// apps/web/src/lib/query-client.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,        // 30 seconds
      gcTime: 5 * 60 * 1000,       // 5 minutes garbage collection
      retry: 2,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});
```

### Query Key Convention

```ts
// Hierarchical keys for cache invalidation
const queryKeys = {
  servers: {
    all: ['servers'] as const,
    detail: (id: string) => ['servers', id] as const,
    members: (id: string) => ['servers', id, 'members'] as const,
  },
  channels: {
    all: (serverId: string) => ['servers', serverId, 'channels'] as const,
    detail: (id: string) => ['channels', id] as const,
    messages: (id: string) => ['channels', id, 'messages'] as const,
  },
  games: {
    session: (id: string) => ['games', 'sessions', id] as const,
  },
};
```

### Optimistic Updates Example

```ts
// Send message with optimistic update
const sendMessage = useMutation({
  mutationFn: (data: { channelId: string; content: string }) =>
    api.channels.sendMessage(data),
  onMutate: async (newMessage) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({ queryKey: queryKeys.channels.messages(newMessage.channelId) });

    // Snapshot previous value
    const previous = queryClient.getQueryData(queryKeys.channels.messages(newMessage.channelId));

    // Optimistically add message
    queryClient.setQueryData(queryKeys.channels.messages(newMessage.channelId), (old) => ({
      ...old,
      data: [...old.data, { ...newMessage, id: 'temp-' + Date.now(), pending: true }],
    }));

    return { previous };
  },
  onError: (err, _, context) => {
    // Rollback on error
    queryClient.setQueryData(queryKeys.channels.messages(newMessage.channelId), context.previous);
  },
  onSettled: () => {
    // Refetch to ensure consistency
    queryClient.invalidateQueries({ queryKey: queryKeys.channels.messages(newMessage.channelId) });
  },
});
```

### Infinite Query for Messages

```ts
const { data, fetchNextPage, hasNextPage } = useInfiniteQuery({
  queryKey: queryKeys.channels.messages(channelId),
  queryFn: ({ pageParam }) =>
    api.channels.getMessages({ channelId, cursor: pageParam, limit: 50 }),
  getNextPageParam: (lastPage) => lastPage.pagination.cursor_next,
  initialPageParam: undefined,
});
```

## Zustand (Real-time & UI State)

### Presence Store

```ts
// apps/web/src/stores/presence.ts
import { create } from 'zustand';

interface PresenceState {
  onlineUsers: Map<string, UserPresence>;
  setUserOnline: (userId: string, presence: UserPresence) => void;
  setUserOffline: (userId: string) => void;
  getOnlineCount: (serverId: string) => number;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  onlineUsers: new Map(),
  setUserOnline: (userId, presence) =>
    set((state) => {
      const next = new Map(state.onlineUsers);
      next.set(userId, presence);
      return { onlineUsers: next };
    }),
  setUserOffline: (userId) =>
    set((state) => {
      const next = new Map(state.onlineUsers);
      next.delete(userId);
      return { onlineUsers: next };
    }),
  getOnlineCount: (serverId) => {
    const users = get().onlineUsers;
    return [...users.values()].filter((u) => u.serverId === serverId).length;
  },
}));
```

### Voice State Store

```ts
// apps/web/src/stores/voice.ts
import { create } from 'zustand';

interface VoiceState {
  currentRoom: string | null;
  participants: Map<string, VoiceParticipant>;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;

  joinRoom: (roomName: string) => void;
  leaveRoom: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  updateParticipant: (userId: string, data: Partial<VoiceParticipant>) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  currentRoom: null,
  participants: new Map(),
  isMuted: false,
  isDeafened: false,
  isSpeaking: false,
  // ... implementations
}));
```

### UI State Store

```ts
// apps/web/src/stores/ui.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarOpen: boolean;
  memberListOpen: boolean;
  activeModal: string | null;
  theme: 'light' | 'dark' | 'system';

  toggleSidebar: () => void;
  toggleMemberList: () => void;
  openModal: (name: string) => void;
  closeModal: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      memberListOpen: true,
      activeModal: null,
      theme: 'system',
      // ... implementations
    }),
    { name: 'lobbyforge-ui' }  // localStorage key
  )
);
```

## Event → State Synchronization

### SSE Events → TanStack Query Cache

```ts
// apps/web/src/lib/event-sync.ts
export function setupEventSync(queryClient: QueryClient) {
  const eventSource = new EventSource('/api/events/stream');

  eventSource.addEventListener('message:new', (e) => {
    const message = JSON.parse(e.data);
    // Append to query cache (avoiding refetch)
    queryClient.setQueryData(
      queryKeys.channels.messages(message.channelId),
      (old) => old ? { ...old, data: [...old.data, message] } : old
    );
  });

  eventSource.addEventListener('presence:update', (e) => {
    const { userId, status } = JSON.parse(e.data);
    if (status === 'online') {
      usePresenceStore.getState().setUserOnline(userId, { status });
    } else {
      usePresenceStore.getState().setUserOffline(userId);
    }
  });

  // ... more event handlers
}
```

### LiveKit Events → Zustand Stores

```ts
// apps/web/src/lib/livekit-sync.ts
export function setupLiveKitSync(room: Room) {
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    useVoiceStore.getState().updateParticipant(participant.identity, {
      joined: true,
      muted: participant.isMicrophoneEnabled === false,
    });
  });

  room.on(RoomEvent.DataReceived, (payload, participant) => {
    const message = JSON.parse(decoder.decode(payload));
    if (message.type.startsWith('game:')) {
      useGameStore.getState().handleGameEvent(message);
    }
  });
}
```

## Game State Store

```ts
// apps/web/src/stores/game.ts
interface GameState {
  sessionId: string | null;
  pluginId: string | null;
  phase: string;
  state: Record<string, unknown>;  // plugin-specific state
  players: GamePlayer[];
  scores: Record<string, number>;

  handleGameEvent: (event: DataChannelMessage) => void;
  sendAction: (action: GameAction) => void;
  reset: () => void;
}
```

## Performance Considerations

### Preventing Unnecessary Re-renders

- **Zustand selectors:** Use `useStore(state => state.specificField)` instead of `useStore()`
- **TanStack Query `select`:** Transform/filter data in `select` to minimize render triggers
- **React.memo:** For participant list items, message items, channel items
- **Virtualization:** Use `@tanstack/react-virtual` for long message lists and member lists

### Memory Management

- TanStack Query `gcTime`: remove unused cache after 5 minutes
- Presence store: cleanup on server switch
- Message cache: keep last 200 messages per channel in memory, older on scroll-up
- Game state: clear on game end
