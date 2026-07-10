# 29 — API Design Standards

## Overview

This document defines the API conventions, patterns, and standards for all LobbyForge endpoints. Consistency across endpoints is critical for developer experience (both internal and plugin/bot developers).

## API Approach: tRPC (Internal) + REST (Public)

### Internal API: tRPC

For communication between the Next.js frontend and backend within the monorepo:

- **End-to-end type safety** — change a return type, get instant TypeScript errors in the UI
- **No code generation** — types flow automatically through the monorepo
- **Subscription support** — SSE-based subscriptions for realtime (replaces custom SSE for some cases)
- **Middleware** — auth, rate limiting, logging as reusable middleware
- **Batching** — multiple queries in a single HTTP request

```ts
// packages/core/src/trpc/routers/channel.ts
export const channelRouter = router({
  list: protectedProcedure
    .input(z.object({ serverId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // type-safe input, type-safe return
      return ctx.db.query.channels.findMany({
        where: eq(channels.serverId, input.serverId)
      });
    }),

  sendMessage: protectedProcedure
    .input(z.object({
      channelId: z.string().uuid(),
      content: z.string().min(1).max(4000),
      replyToId: z.string().uuid().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // ...
    }),
});
```

### Public API: REST

For external consumers (bots, registry, third-party integrations):

- **REST with JSON** — universally understood
- **Versioned:** `/api/v1/...`
- **Documented:** OpenAPI/Swagger spec auto-generated
- **Auth:** Bot token in `Authorization: Bot <token>` header

### Why Both?

| Concern | tRPC | REST |
|---|---|---|
| Internal frontend ↔ backend | ✅ Perfect fit | Overkill |
| Bot SDK | ❌ Requires JS/TS | ✅ Any language |
| Plugin SDK | ✅ (plugins are TS) | Alternative |
| Registry ↔ Instance | ❌ Cross-origin | ✅ Standard HTTP |
| Type safety | ✅ Automatic | ❌ Manual |
| Learning curve | Medium | Low |

## Input Validation

All inputs validated with **Zod** schemas:

```ts
// Shared validation schemas in packages/core/src/schemas/
export const createServerSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  iconUrl: z.string().url().optional(),
  defaultLocale: z.string().default('en'),
  isPublic: z.boolean().default(false),
});

// Used in API route
export const serverRouter = router({
  create: protectedProcedure
    .input(createServerSchema)
    .mutation(async ({ ctx, input }) => { /* ... */ }),
});
```

Validation errors return:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "status": 400,
    "details": {
      "fieldErrors": {
        "name": ["String must contain at least 2 character(s)"],
        "slug": ["Invalid format. Use lowercase letters, numbers, and hyphens."]
      }
    }
  }
}
```

## Rate Limiting

Implemented via Redis sliding window:

| Endpoint Category | Limit | Window |
|---|---|---|
| Auth (login/register) | 5 | 15 min |
| Message send | 10 | 10 sec |
| Message send (burst) | 30 | 60 sec |
| LiveKit token request | 5 | 60 sec |
| File upload | 10 | 60 sec |
| Server create | 3 | 60 min |
| Game action | 30 | 10 sec |
| API general | 60 | 60 sec |
| Bot API | 30 | 60 sec |

Rate limit response headers:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1672531200
Retry-After: 30
```

## Naming Conventions

| Element | Convention | Example |
|---|---|---|
| URL paths | kebab-case, plural nouns | `/api/v1/game-sessions` |
| Query params | camelCase | `?serverId=...&includeRoles=true` |
| Request/response body | camelCase | `{ "displayName": "...", "createdAt": "..." }` |
| Error codes | SCREAMING_SNAKE_CASE | `AUTH_INVALID_CREDENTIALS` |
| Timestamps | ISO 8601 UTC | `"2026-06-03T20:00:00.000Z"` |
| IDs | UUID v7 (time-sortable) | `"0190a5e2-..."` |

## Common Patterns

### Resource Responses

Single resource:
```json
{ "data": { "id": "...", "name": "...", ... } }
```

Collection:
```json
{
  "data": [...],
  "pagination": { "cursor_next": "...", "has_more": true, "limit": 50 }
}
```

### Filtering & Sorting

```
GET /api/v1/servers/:id/members?role=admin&sort=joinedAt&order=desc
```

### Partial Updates

Use `PATCH` with only changed fields:
```
PATCH /api/v1/servers/:id
{ "name": "New Name" }
```

### Batch Operations (Future)

```
POST /api/v1/batch
{
  "operations": [
    { "method": "DELETE", "path": "/messages/abc" },
    { "method": "DELETE", "path": "/messages/def" }
  ]
}
```

## ID Strategy: UUID v7

Use **UUID v7** (RFC 9562) instead of UUID v4:
- Time-sortable — better index performance, natural ordering
- Still globally unique
- PostgreSQL `gen_random_uuid()` generates v4; use application-level generation for v7
- Library: `uuidv7` npm package
