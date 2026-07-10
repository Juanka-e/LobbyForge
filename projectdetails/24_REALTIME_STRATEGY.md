# 24 — Realtime Strategy

## Overview

LobbyForge is a realtime application at its core — voice communication, text chat, game state synchronization, and presence all require low-latency data transport. This document defines the realtime architecture.

## Transport Layers

### Layer 1: LiveKit (Voice + Media + Game Data)

LiveKit provides:
- **WebRTC connection** for voice/video/screen share
- **Data Channels** for arbitrary data (reliable and lossy modes)
- **Server SDK** for server-side room management
- **Webhooks** for participant events

Every user in a voice/activity room already has an active LiveKit connection. We leverage this for game and plugin events.

### Layer 2: Server-Sent Events (Text + Presence + Notifications)

SSE provides:
- **Unidirectional** server-to-client event stream
- **Auto-reconnection** via browser EventSource API
- **Works through Nginx** without special proxy config
- **No additional server** — runs as Next.js API route

Used when the user is NOT in a voice room, or for events that apply globally (new messages in other channels, server updates, notifications).

### Layer 3: REST API (Commands + Mutations)

All state-changing operations go through REST (or tRPC):
- Send message → POST /api/channels/:id/messages
- Game action → POST /api/activities/:id/actions (or via Data Channel for low-latency)
- Update settings → PATCH /api/servers/:id

## Event Flow Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        CLIENT                           │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ REST Client  │  │  SSE Client  │  │ LiveKit SDK   │  │
│  │ (mutations)  │  │  (events)    │  │ (voice+data)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
└─────────┼─────────────────┼─────────────────┼───────────┘
          │                 │                 │
    HTTPS │          SSE    │         WebRTC  │
          │                 │                 │
┌─────────┼─────────────────┼─────────────────┼───────────┐
│         ▼                 ▼                 ▼           │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Next.js API  │  │  SSE Handler │  │ LiveKit SFU   │  │
│  │  Routes      │  │  (per-user   │  │ + Data CH     │  │
│  │              │  │   Redis sub) │  │  Handler      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                 │                 │           │
│         ▼                 ▼                 ▼           │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Redis Pub/Sub                       │   │
│  │  server:{id}:events  channel:{id}:events         │   │
│  │  game:{id}:events    user:{id}:notifications     │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                              │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │              PostgreSQL                          │   │
│  │  (persistent state, messages, game records)      │   │
│  └──────────────────────────────────────────────────┘   │
│                        SERVER                           │
└─────────────────────────────────────────────────────────┘
```

## SSE Implementation Details

### Connection Management

```ts
// GET /api/events/stream
export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response('Unauthorized', { status: 401 });

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe to user's channels via Redis
      const channels = await getUserSubscriptions(session.userId);
      const subscriber = redis.subscribe(channels);

      subscriber.on('message', (channel, message) => {
        controller.enqueue(`data: ${message}\n\n`);
      });

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        controller.enqueue(': heartbeat\n\n');
      }, 30000);

      // Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        subscriber.unsubscribe();
        clearInterval(heartbeat);
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

### Event Format

```
id: 550e8400-e29b-41d4-a716-446655440000
event: message:new
data: {"channelId":"...","message":{"id":"...","content":"Hello","userId":"...","createdAt":"..."}}

```

### Redis Pub/Sub Channel Mapping

When a user connects to SSE:
1. Subscribe to `user:{userId}:notifications`
2. For each server membership: subscribe to `server:{serverId}:events`
3. For the active channel: subscribe to `channel:{channelId}:events`
4. On channel switch: unsubscribe old channel, subscribe new

## LiveKit Data Channel Protocol

### Message Format

```ts
interface DataChannelMessage {
  type: string;          // e.g., 'game:action', 'typing:start', 'chat:message'
  payload: unknown;      // event-specific data
  timestamp: number;     // Unix ms
  sender?: string;       // userId (set by server, not trusted from client)
}
```

### Plugin/Game Data Flow

```
Player presses "Correct" in Hushle
  → Client sends DataChannelMessage { type: 'game:action', payload: { action: 'correct' } }
  → LiveKit delivers to all participants (including server-side participant)
  → Server-side handler validates action against game state
  → Server updates Redis game state
  → Server broadcasts new state via Data Channel (RELIABLE)
  → All clients update UI
```

**Server-side LiveKit participant:** A headless LiveKit participant running in the Next.js server (or a worker) that joins each active game room to process data channel messages. This is the game state authority.

## Scaling Considerations

### MVP (Single VPS)
- Single SSE endpoint handles all connections
- Single Redis instance for pub/sub
- LiveKit handles its own scaling internally
- Expected limit: ~200-500 concurrent SSE connections per VPS

### Future Scaling
- Multiple Next.js instances behind Nginx load balancer
- SSE connections distributed across instances
- Redis Pub/Sub ensures all instances receive all events
- Sticky sessions NOT required (Redis is the coordination point)
- Consider Redis Streams for event history/replay

## Reconnection & Consistency

### SSE Reconnection
1. Browser EventSource auto-reconnects (default: immediate retry)
2. Server supports `Last-Event-ID` header
3. Events since last ID replayed from Redis Stream buffer (last 5 minutes)
4. If gap > 5 minutes: client fetches full state via REST

### LiveKit Reconnection
1. LiveKit SDK handles automatic reconnection
2. On reconnect to game room: client requests game state snapshot
3. Server sends full state via Data Channel (RELIABLE)
4. Client reconciles with local state

### Consistency Guarantees
- **Messages:** REST API is source of truth. SSE is notification. Client fetches from REST on doubt.
- **Game state:** Redis cache is hot state. PostgreSQL is durability backup. On Redis failure, game pauses.
- **Presence:** Eventually consistent (30s heartbeat). Acceptable for MVP.
