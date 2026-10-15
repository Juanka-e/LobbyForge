# Profiles

Click someone anywhere in the lobby and their profile card opens, the way it
does in Discord. This page covers the card, the full profile, the image
viewer, the API behind them and the privacy and permission rules they follow.

- [Where the card opens](#where-the-card-opens)
- [What the card shows](#what-the-card-shows)
- [What you can do from it](#what-you-can-do-from-it)
- [The full profile](#the-full-profile)
- [The image viewer](#the-image-viewer)
- [The profile API](#the-profile-api)
- [Profile fields](#profile-fields)
- [Mentions](#mentions)
- [Live updates](#live-updates)
- [Privacy](#privacy)
- [Permissions: `viewerCan`](#permissions-viewercan)
- [Accessibility](#accessibility)
- [For developers](#for-developers)
- [Not done yet](#not-done-yet)

## Where the card opens

| Place | How |
|---|---|
| Member list | Click a row. The card gets the row's live status. |
| Chat | Click the author's avatar or name, or a mention chip (`@Ada`) in a message. Bots, webhooks and apps have their own badges and no card. |
| Voice roster | Left-click a participant (shown with their photo). Right-click and the "⋮" button still open the moderator menu. |
| Direct messages | Click the header (avatar and name), or an author's avatar or name. |
| Your account block | Click your avatar to open your own card. Click your name to open the status menu, as before. |

Only one card is open at a time. Clicking another person switches the card,
and clicking the same person again closes it. A click anywhere else closes it
too.

A mention in a message opens the card of the member it names; see
[Mentions](#mentions).

## What the card shows

From top to bottom:

- **Banner.** The member's banner. Without one, a band in their profile
  colour ([Profile fields](#profile-fields)); without that, the main colour of
  their avatar. The colour is sampled from the image on a small canvas. If
  that fails, the band takes the colour of their highest coloured role, then
  the theme accent (`--lf-user-accent`). Only same-origin avatars are sampled:
  an external image would taint the canvas.
- **Avatar** with a status dot. The dot shows the status the member chose:
  Online, Idle, Do Not Disturb, or Offline. When you look at your own card,
  Offline reads Invisible, because that is what you picked. Being in voice is
  shown separately, as an "In voice" badge.
- **Names**, Discord's way: the name this community sees (the nickname, if
  there is one) in large type, and the account's own name under it when a
  nickname replaces it. Under the names, `@handle · pronouns` when the member
  set them. Then a Guest badge, a crown for the community owner, and the
  custom status as a speech bubble. A profile colour also draws a thin ring at
  the edge of the photo.
- **About me**: the bio, or "No bio yet.".
- **Member since**: when the LobbyForge account was created and when they
  joined this community. Both dates are in the viewer's language
  (`Intl.DateTimeFormat`).
- **Roles**: chips with each role's colour dot or icon, highest first,
  without `@everyone`.
- **Mutual communities**: the count and the first few icons. This section
  appears only when you share a community other than this one, so on a
  single-community self-host it does not appear.
- **Volume**: your local volume for this member, while they are in voice.
- **Message @name**, and a **View full profile** link.

The card opens at once with what the lobby already rendered: name, avatar,
bio, status text and roles. Then it fills in from the profile API, with grey
placeholders for the parts still loading.

- **Status and "In voice"** come from the opener only when it knows them
  live. The member list knows the live status, and the voice room knows who
  is in it. Every other opener takes both from the API, because the page's
  own copy is stale.
- **Cache.** Answers are cached per (community, member) for the browser
  session. The cache belongs to one viewer: it empties when someone else
  signs in on the same tab.
- **Refreshing.** A cached answer shows at once. If it is older than 30
  seconds, the card asks again in the background. It always asks again for
  your own card, since you may have just edited it.
- **After a change** made through the card (roles, a timeout, a block), that
  one profile reloads.
- **The member list follows.** Every fresh answer from the profile API
  (not one read from the cache) hands the member's roles to the lobby's
  member list, which is otherwise the page render's. A role added or removed
  in the card moves the member to the right role heading, with the right
  name colour, at once, instead of on the next page load
  (`memberRoles` in `ProfileCardProvider`).

## What you can do from it

Every action goes through a route that already existed. The card only shows
what [`viewerCan`](#permissions-viewercan) allows, and the route checks
everything again.

| Action | Route | Shown when |
|---|---|---|
| Message @name: type, press Enter | `POST /api/dm`, then `POST /api/dm/{id}/messages`. The conversation then opens in the centre column, titled with the account's name like the DM list. | `viewerCan.message`: not yourself, and not someone you blocked. If they blocked you, the DM route refuses with "You can't message this member." |
| Copy user ID | — | always |
| Block / Unblock | `POST /api/settings/me/blocks`, `DELETE …/{userId}` (BlockListProvider) | not yourself |
| Add role (+), remove role (×) | `PUT /api/servers/{id}/members/{userId}/role` with the whole new set, `@everyone` kept | `viewerCan.manageRoles`, and only the roles listed |
| Timeout / Remove timeout | `PUT /api/servers/{id}/members/{userId}/timeout` | `viewerCan.timeout` |
| Kick | `DELETE /api/servers/{id}/members/{userId}` | `viewerCan.kick` |
| Ban, with an optional reason | `POST /api/servers/{id}/bans` | `viewerCan.ban` |
| Server mute / unmute | `POST /api/servers/{id}/channels/{ch}/members/{userId}/voice/mute` | `viewerCan.serverMute`, while the member is in your voice room |
| Edit profile | link to `/settings/profile` | your own card |
| Set your status | the voice provider's presence status | your own card |

Timeout, Kick and Ban ask first. A timeout can last 60 seconds, 5 or 10
minutes, 1 hour, 1 day or 1 week. The admin Members page has no timeout
control, so these are Discord's own lengths, all under the route's 28-day
cap. The ban reason is optional and up to 512 characters, like the admin
page's prompt. A refusal shows inside the dialog, or under the roles, in the
viewer's language. The message comes from the route's `code`
(`insufficient_rank`, `actor_timed_out`, `target_is_owner`, …), never from its
English `error` (`lib/profile-action-errors.ts`). The kick, ban, role and
timeout routes give their own refusals a code too (`unauthenticated`,
`server_not_found`, `invalid_request`, `already_banned`, `role_above_actor`,
`ungrantable_permissions`, …); the admin Members page says them the same way. A member who is kicked or
banned leaves the member list at once, and a short notice says so.

Because the role route replaces the whole set, the card reads the member's
roles fresh right before each change and applies the edit to that set. A set
built from an answer cached minutes ago would quietly undo a role that
another moderator, or the admin Members page, gave in the meantime.

## The full profile

"View full profile" (or the mutual communities row) opens a larger modal with:

- the banner and avatar (both open the image viewer);
- the names, the status and the custom status;
- **About**: the bio, Member since and Roles, with the same role controls as
  the card;
- **N mutual communities**: each community with its icon and name. Each one
  is a link to `/lobby?server={id}`, and the current one is marked "This
  community".

The "⋯" menu holds the same actions as the card's. Arrow keys, Home and End
move between the tabs.

## The image viewer

`components/ImageLightbox.tsx` is a shared, generic viewer. Profiles use it
for avatars and banners, and chat image attachments can use it later.

- It shows the image centred on a dimmed backdrop, up to about 80 vmin, with
  a short zoom-in. There is no animation under `prefers-reduced-motion` or
  the app's own reduced-motion setting (`.lf-zoom-in` in `globals.css`).
- Escape, a click on the backdrop, or the X closes it. Focus stays inside and
  then returns to the avatar or banner that opened it.
- The image's alt text says whose avatar or banner it is.
- "Open original" opens the same-origin image URL in a new tab.

## The profile API

```
GET /api/servers/{serverId}/members/{userId}/profile
```

The route uses `withApiSecurity`, needs a session and is limited to 120
requests a minute. The answer has `Cache-Control: no-store`.

```jsonc
{
  "profile": {
    "userId": "…",
    "displayName": "Ace",                 // nickname, else the account's name
    "globalDisplayName": "Alice",
    "nickname": "Ace",                    // or null
    "avatarUrl": "/api/users/…/avatar?v=…", // versioned URL, or null
    "bannerUrl": "/api/users/…/banner?v=…", // versioned URL, or null
    "isGuest": false,
    "username": "ace",                    // the handle, or null — shown like a name
    "statusText": "Building",             // custom status, or null
    "bio": "…",                           // or null
    "pronouns": "she/her",                // or null (unset, or withheld when limited)
    "accentColor": "#5865f2",             // profile colour, or null (unset, or withheld when limited)
    "presence": "idle",                   // online | idle | dnd | offline, or null
    "inVoice": false,                     // in a voice room of this community the viewer can see
    "roles": [{ "id": "…", "name": "Mods", "color": "#ff8800", "icon": "shield", "position": 10, "displaySeparately": true }],
    "memberSince": "2026-02-03T04:05:06.000Z",      // or null
    "accountCreatedAt": "2025-01-02T03:04:05.000Z", // or null
    "mutualServers": [{ "id": "…", "name": "…", "iconUrl": null }],
    "mutualServerCount": 2,
    "blockedByMe": false,
    "limited": false,          // details withheld: a hidden profile, or a block either way (which, is not said)
    "isOwner": false,          // the member owns this community
    "timedOutUntil": null      // ISO time, only for viewers who may time the member out
  },
  "viewerCan": {
    "isSelf": false,
    "message": true,
    "kick": false, "ban": false, "timeout": false, "serverMute": false,
    "manageRoles": false,
    "assignableRoles": [],     // roles the viewer may add, highest first
    "removableRoleIds": [],    // roles the viewer may remove
    "currentRoleIds": []       // every role held, @everyone included (the role PUT replaces the set)
  }
}
```

**Access.** The viewer must be the owner or a current member of the server,
and the subject must be a current member: a live account, a live server, and
no active ban (a membership row that outlived a ban does not count). If any
of this fails, or the ids are malformed, the answer is the same 404. The route
can't be used to find out who belongs where.

- **Roles** are the ones the member holds in this server: the join table plus
  the legacy primary role, highest first, without `@everyone` and without
  their permissions. `displaySeparately` says whether online holders get
  their own heading in the member list.
- **Presence** goes through the same projection as `GET /api/presence`
  (`applyPresencePrivacy`). A hidden online status, a heartbeat older than 90
  seconds, no heartbeat at all, or the Invisible choice all read as
  `offline`. If Redis is down, presence also reads `offline`, not an error.
- **In voice** follows the member list's rule. The member must be in a voice
  or stage channel of this community that the viewer can see, with a status
  the viewer may see. A role-gated room the viewer can't see counts as not
  in voice.
- **Mutual communities** are the communities both people currently belong to,
  on a live server, where neither has an active ban. There is no list for
  your own profile. The answer names up to 50 of them, and the count covers
  all of them. Icons are passed only as https URLs, never as data URLs. The
  viewer is a member of every community listed, so the list reveals nothing
  new.

The database half lives in `packages/db/src/queries/memberProfiles.ts`:
`getMemberProfileRecord` and `listMutualServers`.

## Profile fields

Migration 0050 adds three columns to `users`, edited in Settings → Profile
and shown on the card. All three are nullable: every account from before
0050, and every guest, simply has none.

| Field | Rules | Shown |
|---|---|---|
| **Handle** (`username`) | 2–32 of `a-z 0-9 _ .`, stored lowercase, unique (a unique constraint plus a format CHECK). No leading, trailing or doubled dot. Reserved: `everyone`, `here`, `admin`, `administrator`, `moderator`, `mod`, `owner`, `system`, `lobbyforge`, `support`, `staff`, `bot`, `webhook`. Guests can't take one. | `@handle` under the names, always (a name, like the display name). Typed in chat it is a mention. |
| **Pronouns** | Free text, at most 40 characters, no control characters, whitespace collapsed. | Next to the handle — withheld like the bio. |
| **Profile colour** (`accent_color`) | `#rrggbb`, stored lowercase (a CHECK). Twelve swatches, any colour from the picker, or Automatic. | The card's band without a banner, and the ring around the photo — withheld like the bio. |

The settings page checks a handle while you type: the format rules at once,
then `GET /api/users/me/username?name=…` after a short pause (60 a minute;
handles are visible to fellow members anyway). The page shows a preview of
the band, the photo ring, the name and `@handle · pronouns`.

`PATCH /api/users/me/profile` takes `username`, `pronouns` and `accentColor`
next to the old fields (`null` or an empty string clears one). Refusals carry
a code the page translates: `username_too_short`, `username_too_long`,
`username_characters`, `username_dots`, `username_reserved`,
`username_guest` (403), `username_taken` (409), `pronouns_too_long`,
`pronouns_characters`, `accent_color_invalid`, `invalid_profile`.

**Community nicknames.** Settings → Profile → "Server-specific" lists every
community the account is in and edits the nickname of the one picked; the
profile card's "Edit profile" opens it on the card's community
(`/settings/profile?server=…`). `PATCH /api/users/me/server-profile` takes
`serverId` and checks the membership (`409 no_community` otherwise). Before,
the nickname always went to the account's newest community, whatever lobby it
was set from.

## Mentions

A message's text stays plain (`hi @Ada Lovelace`), so bots, notifications and
older clients read it as before. Who a mention names is kept beside it, in
`metadata.mentions`: `[{ "userId": "…", "text": "Ada Lovelace" }]`, where
`text` is what follows the `@`. Only the server writes it
(security-review AUTHZ-008 still refuses client metadata):

- the composer sends `mentions: [userId…]` — the members picked from the `@`
  list whose name is still in the text;
- the messages route (post and edit) keeps a pick only if it is a current
  member whose nickname, account name or handle stands as `@…` in the text,
  and adds every typed `@handle` of a current member
  (`lib/message-mentions-server.ts`). An edit keeps the earlier mentions whose
  names are still there. At most 20.

The lobby turns each stored `@text` into a chip that opens that member's card,
marks `@everyone` / `@here`, and highlights a message that names the viewer
(or pings everyone) with an amber bar, as Discord does. The `@` list matches a
handle too, and folds case the viewer's way (Turkish `İ`/`I`).

**Notifications.** Each member a new message names hears it on their own feed
(`user:{uid}`, `{ type: "mention", serverId, channelId, messageId,
fromUserId }`, `lib/mention-notify.ts`) — only if they may read that channel,
never the author, never someone who blocked the author, and with no text. The
channel list gives that channel a red badge with the count until it is
opened, and a hidden tab gets a desktop notification. Settings →
Notifications now does what it says: "Unread badge" turns the badges on or
off, "Suppress while in voice" keeps a voice room quiet, and the sound choice
plays the page's own chime, a soft pop, or nothing (`lib/notification-prefs.ts`).

## Live updates

The lobby's member rows used to be the page render's: someone who joined, a
new name or avatar, roles handed out by somebody else — all waited for a
reload. They now arrive live.

- **`members:{serverId}`** is a new gateway topic (any member may subscribe;
  a kick, ban or role change re-checks it). Its events say WHO changed, never
  what, and the gateway forwards nothing but these three shapes
  (`apps/ws-gateway/src/member-events.ts`):
  - `members-changed { userIds }` — joined, or their profile, nickname,
    roles or timeout changed;
  - `members-removed { userIds }` — left, kicked or banned;
  - `roles-changed` — a role's name, colour, icon, grouping or order changed,
    or a role was deleted.
- `lib/member-bus.ts` publishes them from every route that changes those
  things (join paths, kick and leave, ban, timeout, role assignment, role
  edit and delete, nickname, and the account's own profile, avatar and banner
  — which reach every community it belongs to).
- `LiveMembersProvider` re-reads exactly the named rows from
  `GET /api/servers/{id}/lobby-members?ids=…` (projected for the viewer like
  the page render; owner or member only; up to 100 ids; `missing` lists those
  no longer members), or everyone after `roles-changed` or a reconnect. The
  member list, the profile card (an open card re-reads), chat author names,
  the mention list and the voice roster all read these rows; status stays the
  presence feed's.
- **DMs.** A DM message also tells both participants' feeds
  (`{ type: "dm_activity", channelId, fromUserId }`, no text). The sidebar's
  DM list re-reads `GET /api/dm`, so a conversation someone else started
  appears, and one that is not open gets an unread dot until it is opened.

## Privacy

The route uses the lobby's own projection: `canViewProfile` and
`projectMemberProfile` in `lib/profile-privacy.ts`, the same functions that
build the member list. Nothing the lobby would hide comes through the API.

| | Full profile | Hidden profile (`profileVisibility` shuts the viewer out) | They blocked you | You blocked them |
|---|---|---|---|---|
| Names, handle, Guest tag, roles, owner crown | yes | yes | yes | yes |
| Avatar | yes | no | no | if the privacy setting allows (the block list's rule, `projectBlockedUser`) |
| Banner, bio, custom status, pronouns, profile colour | yes | no | no | no |
| Member since, account created | yes | no | no | no |
| Mutual communities | yes | no | no | no |
| Presence, in voice | per presence privacy | per presence privacy | per presence privacy | no (like the presence feed) |
| Message @name | yes | yes | yes (the DM route refuses) | no |
| `limited` | false | true | true | true |

- The viewer always shares this server with the member, so "Server members"
  passes. "Nobody" shuts out everyone but the member themselves. Owners and
  moderators get no bypass, the same as the member list.
- A block hides the payload in both directions.
- A member who blocked you gets exactly the answer a hidden profile gets, so
  the card is no way to find out you were blocked. `blockedByMe` is only
  your own block, which your block list already shows.
- **Two places still give a block away**, and this change does not add a
  third:
  - the DM route answers a different refusal in each direction;
  - the member list still shows the avatar and bio of someone who blocked
    you, because the lobby projects privacy, not blocks.

  Closing these is a next step.
- A block doesn't change what a moderator may do. `viewerCan` is about the
  viewer's rights, not the member's data.

## Permissions: `viewerCan`

`lib/member-capabilities.ts` works out `viewerCan` with the same rules as the
moderation gate, `authorizeModerationTarget` in `lib/member-authorization.ts`.
The gate now imports its permission map and rank comparison from this module,
so the two can't drift apart.

1. The viewer must be a member, or the owner.
2. The viewer needs the action's permission: Kick Members, Ban Members,
   Moderate Members (timeout), Manage Roles, or Mute Members (server mute).
   The owner holds every permission.
3. A timed-out viewer may do nothing. This never applies to the owner.
4. No one may act on themselves, and no one may act on the owner.
5. The owner may act on anyone else. Everyone else must rank strictly above
   the member: equal rank can't act on equal rank.

Role assignment adds the role route's own rules. A non-owner may hand out
only roles strictly below their highest role, and only roles whose
permissions they could grant themselves. Nobody but the owner can grant
`administrator` (`lib/role-grant-policy.ts`). `@everyone` is never offered
and never removed.

## Accessibility

- The card is a dialog named "{name} profile". Focus moves into it when it
  opens, stays inside on Tab and Shift+Tab, and returns to whatever opened it
  when you close it with Escape or the X (`lib/use-focus-trap.ts`). Escape
  closes the card even when focus is somewhere else, unless another dialog
  or menu has it. Until the card is placed it is only transparent, never
  `visibility: hidden`, so it can take focus as soon as it opens.
- The full profile, the image viewer and the confirmations are modal dialogs
  with the same focus handling. Escape closes only the topmost one. In the
  "⋯" menu and the role list, Escape closes only that menu or list.
- Every action works from the keyboard. The menus use arrow keys, Home and
  End, and the role list also uses Enter. The chat avatar is a second way to
  the same card as the author's name, so it is left out of the tab order and
  hidden from screen readers.
- Status is never shown by colour alone: the dot has a label, and the name
  block says the status in words.

## For developers

| File | What |
|---|---|
| `apps/web/app/api/servers/[id]/members/[userId]/profile/route.ts` | the API |
| `packages/db/src/queries/memberProfiles.ts` | one member's record, mutual communities |
| `apps/web/lib/member-capabilities.ts` | `viewerCan`, shared with the moderation gate |
| `apps/web/lib/member-profile.ts` | response types, the session cache, merging seed and answer |
| `apps/web/app/lobby/ProfileCardProvider.tsx` | the lobby's one card, `useProfileCard()`, `ProfileTrigger` |
| `apps/web/components/modals/UserProfilePopover.tsx` | the card |
| `apps/web/components/modals/FullProfileModal.tsx` | the full profile |
| `apps/web/components/modals/profile/*` | shared pieces, the "⋯" menu, the confirmations, the actions |
| `apps/web/components/ImageLightbox.tsx` | the image viewer |
| `apps/web/lib/profile-accent.ts` | the banner band's colour |
| `apps/web/lib/profile-fields.ts` | handle, pronouns and colour rules (page and route) |
| `apps/web/lib/mentions.ts`, `lib/message-mentions-server.ts`, `lib/mention-notify.ts` | mention parsing, resolution, notifications |
| `apps/web/lib/member-bus.ts`, `app/lobby/LiveMembersProvider.tsx` | live member rows |
| `apps/web/app/api/servers/[id]/lobby-members/route.ts` | member rows for the live lobby |
| `apps/ws-gateway/src/member-events.ts` | what a `members:` subscriber may receive |

To make a new place open the card, wrap the person in
`<ProfileTrigger userId={…} seed={{ displayName }}>`. Outside the live lobby
(no provider) it renders the same content without the button.

Tests:

- `app/api/servers/[id]/members/[userId]/profile/__tests__/profile.test.ts`:
  access, privacy, blocks, presence and `viewerCan`;
- `lib/__tests__/member-capabilities.test.ts`: `mayModerate` against the real
  gate over every combination of facts;
- `packages/db/src/__tests__/member-profiles*.test.ts`: unit tests, plus an
  integration test that runs with `TEST_DATABASE_URL`;
- `components/modals/__tests__/UserProfilePopover.test.tsx`,
  `components/__tests__/ImageLightbox.test.tsx` and
  `app/lobby/__tests__/ProfileCard.test.tsx`;
- `e2e/profile-card.spec.ts`, which runs against the compose stack.

## Not done yet

- **Unread marks for every message.** Channels show a badge for mentions of
  the viewer; a mark for any new message needs a per-viewer "channel
  activity" feed that respects channel visibility. The old dot (lit for a
  channel merely opened in the last seconds) is gone.
- **Mentions in DMs, from bots, of roles; `@everyone` notifications.** Member
  mentions in community channels only; an edit that adds a mention does not
  notify (Discord doesn't either).
- **Image viewer for chat attachments.** The viewer is generic; chat has no
  image attachments to open yet.
- **A DM with someone who is not in this community** opens a card with just
  the name and avatar from the DM. The profile API is per community.
- **The two other places that give a block away**: the DM route's two
  refusals, and the member list's profile fields (see [Privacy](#privacy)).
- **A role-set precondition.** The role route has no `expectedRoleIds` check
  (answering 409 on a mismatch). The card works around this by reading the set
  fresh before each change, but two changes at the very same moment could
  still race.
