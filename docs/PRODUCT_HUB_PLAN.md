# Product Plan — Official Hub, Discover, Official Instance

Status: Accepted direction — 2026-09-17. Scheduled as the **first
product sprint AFTER the v0.2.0-rc.1 release drill**. Not yet
implemented; this document is the scope contract for that sprint.

## The architectural rule (ADR-006)

The Official Hub and self-host instance auth are NEVER mixed. The Hub
has no login/register. Identity is instance-local; self-hosting has no
central account dependency. The future LobbyForge ID is an optional
identity provider only — see ADR-006.

## Surface map

| Surface | Address | Role |
|---------|---------|------|
| Official Hub | lobbyforge.com | Landing + discovery + downloads + docs |
| Instance Directory | lobbyforge.com/discover | Public LobbyForge servers |
| Instance detail | lobbyforge.com/discover/[instanceId] | Card → details before the jump |
| Connect flow | lobbyforge.com/connect | Instance URL entry / QR / deep link |
| Official Instance | community.lobbyforge.com | LobbyForge's own real community (dogfood) |
| Docs | docs.lobbyforge.com (or /docs) | Self-host guides |
| Registry API | existing apps/registry service | Directory backend (unchanged) |

## Current state → target (honest gap list)

- `(marketing)/landing/page.tsx` (314 lines, at `/landing`) → rebuild
  as the real product landing at `/`.
- `(discover)/discover` (DiscoveryGrid + page) → evolve into the
  product Discover: filterable cards (search, language, category,
  online now, verified, guest access, registration open) + instance
  detail pages.
- `connect/page.tsx` is the **phase-1 M9 demo** (guest + LiveKit token
  walk-through, self-described as "removed once the real UI lands") →
  replace with the product Connect page (URL entry, recent instances,
  desktop deep-link handoff).
- `/download` — new (desktop bundles + SHA256SUMS from releases).
- Official instance — a real deployment (own VPS, own install), not
  code. Channel structure below.
- Beta scope does NOT include: Trending/Featured ranking
  (abuse-resistant ranking is its own project), hub login/register,
  LobbyForge ID implementation.

## Landing (lobbyforge.com/)

First screen is one message, not a 40-feature dashboard:

> **Your community. Your server. Your rules.**
> Self-hosted voice, chat and live activities without handing your
> community to a centralized platform.

Primary actions: **Explore Communities** · **Host LobbyForge**.
Secondary: Download Desktop. Below, four value sections: Voice-first
(LiveKit/TURN) · Self-hosted (your domain, your data) · Live Activities
(Hushle, Quiz, plugin SDK) · Open ecosystem (marketplace + community
plugins).

## Discover

Card: logo, name, domain, category · language, member count, online
count, `[Open Community]`. Filters first (search/language/category/
online/verified/guest-access/registration-open); Featured/Trending/New
come later. Detail page (`/discover/[instanceId]`) shows banner,
description, tags, online users, public rooms, registration + guest
policy, owner-verified state, last heartbeat, software version, and
two exits: **Open in Browser** / **Open in LobbyForge Desktop** —
people are never blind-redirected to an unknown domain.

## Connect (/connect)

"Connect to a LobbyForge community": URL field + Continue, recent
instances, and `Open in LobbyForge` when the desktop app is installed
(the existing deep-link/instance binding makes this work).

## Self-host CTA (/self-host)

Honest requirements (Docker-capable Linux VPS, domain, 2–4 GB RAM) and
the REAL steps: clone tagged release → run installer → complete setup →
invite community. **No one-command marketing during beta.**

## Instance auth shell (shared login/register UI)

```
┌──────────────────────────────┐
│        Instance logo         │
│     Welcome to <Instance>    │
│  [ Email ]  [ Password ]     │
│        [ Sign in ]           │
│     Continue with Google     │
│  No account? Sign up         │
│      Powered by LobbyForge   │ ← small; instance identity dominates
└──────────────────────────────┘
```

Register reflects the instance's actual backend policy: open
registration (form) · invite-only (invite code field) · closed (notice)
· guest enabled (`Continue as Guest` on login).

## Official Instance (community.lobbyforge.com)

Real `/login` `/register` `/lobby` `/servers/...` `/settings` flows —
the product demo that needs no install, and our real-world dogfood:
new releases run here first. Initial channels:

```
LobbyForge Official
├── Welcome
├── Announcements
├── General
├── Help & Support
├── Self-Hosting
├── Plugin Development
├── Showcase
└── Voice Lounge
```

## Visual separation

Shared design system, different behavior: Hub = marketing surface
(hero, screenshots, directory, download, docs). Instance = the
app shell (servers, channels, voice, DMs, activities). Login/register
share components; the Hub having no login keeps it unambiguous.

## Sprint scope (beta minimum — 6 items)

1. `/` real landing
2. `/discover` directory UI (registry-backed)
3. `/discover/[id]` instance detail
4. `/connect` product connect page (replaces the M9 demo)
5. `/download` desktop downloads
6. community.lobbyforge.com official instance + polish of existing
   `/login` `/register` `/setup`

Deferred: LobbyForge ID (optional IdP concept — see ADR-006),
Trending/ranking, docs subdomain split.
