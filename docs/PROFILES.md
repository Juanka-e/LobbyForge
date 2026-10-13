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
- [Privacy](#privacy)
- [Permissions: `viewerCan`](#permissions-viewercan)
- [Accessibility](#accessibility)
- [For developers](#for-developers)
- [Not done yet](#not-done-yet)

## Where the card opens

| Place | How |
|---|---|
| Member list | Click a row. The card gets the row's live status. |
| Chat | Click the author's avatar or name. Bots, webhooks and apps have their own badges and no card. |
| Voice roster | Left-click a participant. Right-click and the "⋮" button still open the moderator menu. |
| Direct messages | Click the header (avatar and name), or an author's avatar or name. |
| Your account block | Click your avatar to open your own card. Click your name to open the status menu, as before. |

Only one card is open at a time. Clicking another person switches the card,
and clicking the same person again closes it. A click anywhere else closes it
too.

Mentions in messages are plain text. Messages don't store which user a
mention points to: the composer's `@` autocomplete keeps no id, and the
messages route refuses client metadata (security-review AUTHZ-008). A mention
can't open a card until messages store mention ids.

## What the card shows

From top to bottom:

- **Banner.** The member's banner. Without one, a band in the main colour of
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
  nickname replaces it. Then a Guest badge, a crown for the community owner,
  and the custom status as a speech bubble.
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
English `error` (`lib/profile-action-errors.ts`). A member who is kicked or
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
    "statusText": "Building",             // custom status, or null
    "bio": "…",                           // or null
    "presence": "idle",                   // online | idle | dnd | offline, or null
    "inVoice": false,                     // in a voice room of this community the viewer can see
    "roles": [{ "id": "…", "name": "Mods", "color": "#ff8800", "icon": "shield", "position": 10 }],
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
  their permissions.
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

## Privacy

The route uses the lobby's own projection: `canViewProfile` and
`projectMemberProfile` in `lib/profile-privacy.ts`, the same functions that
build the member list. Nothing the lobby would hide comes through the API.

| | Full profile | Hidden profile (`profileVisibility` shuts the viewer out) | They blocked you | You blocked them |
|---|---|---|---|---|
| Names, Guest tag, roles, owner crown | yes | yes | yes | yes |
| Avatar | yes | no | no | if the privacy setting allows (the block list's rule, `projectBlockedUser`) |
| Banner, bio, custom status | yes | no | no | no |
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

- **Clickable mentions.** They need messages to store mention user ids first
  (see above).
- **Pronouns, a handle, a profile accent colour.** Each needs a new column,
  so none is in this change.
- **Image viewer for chat attachments.** The viewer is generic; chat has no
  image attachments to open yet.
- **Live role chips in the member list.** A role change made through the card
  updates the card at once. The member list's role groups update on the next
  page load.
- **A DM with someone who is not in this community** opens a card with just
  the name and avatar from the DM. The profile API is per community.
- **The two other places that give a block away**: the DM route's two
  refusals, and the member list's profile fields (see [Privacy](#privacy)).
- **A role-set precondition.** The role route has no `expectedRoleIds` check
  (answering 409 on a mismatch). The card works around this by reading the set
  fresh before each change, but two changes at the very same moment could
  still race.
