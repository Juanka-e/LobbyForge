# 31 - Urun Kararlari: Auth, Apps, Oyun HUD, Settings, Update

Bu dokuman, `yapayzekaanaliz.md` sonrasi netlestirilen urun ve mimari kararlarin uygulama rehberidir.

## 1. "Official hub + self-host birlikte yasar" ne demek?

Bu ifade, LobbyForge'un iki farkli kullanim yolunu ayni urun icinde desteklemesi demektir:

1. **Official LobbyForge hub/app**
   - `lobbyforge.org` veya official desktop app.
   - Kullanici official hesapla girer.
   - Public registry, app catalog, official community, developer portal, saved instances ve desktop preferences burada yasar.

2. **Self-host instance**
   - Bir toplulugun kendi domain/IP uzerinde kurdugu bagimsiz LobbyForge.
   - Kendi PostgreSQL, Redis, LiveKit, roles, bans, messages, app installs ve audit log verisini tutar.
   - Registry'ye kaydolmak zorunda degildir.

Self-host instance registry'ye kaydolmazsa:

```txt
Kullanici -> direkt domain/IP ile baglanir
Registry -> bu instance'i bilmez
Official app -> sadece manual connect/saved instance olarak saklayabilir
```

Self-host instance registry'ye kaydolursa:

```txt
Kullanici -> official registry'de instance'i gorur
Registry -> sadece public metadata + health/doctor/listing bilgisi tutar
Instance -> auth, data, moderation ve app install kararlarini kendi verir
```

## 2. Self-host instance auth politikasi

Instance sahibi admin panelinden disaridan gelen kullanicilar icin auth politikasini secebilmelidir.

### Onerilen ayar

```txt
Admin -> Settings -> Access & Auth

Join policy:
- Invite only
- Public with approval
- Public self-register
- Guest allowed

External identity:
- Off
- Allow Sign in with LobbyForge
- Require Sign in with LobbyForge for registry visitors

Local account:
- Allow local email/password
- Disable local registration, existing local users only
- Guest only for invite links

Account linking:
- Allow users to link local account with LobbyForge account
- Auto-create local account from LobbyForge account
- Require admin approval for first join
```

### Karar

Evet, su yapi mantiklidir:

- Kendi uygulamasina direkt gelenler icin local register/login/guest.
- Registry veya official app'ten gelenler icin instance sahibinin secimine gore:
  - yine local register/login,
  - optional "Sign in with LobbyForge",
  - veya zorunlu "Sign in with LobbyForge".
- Her durumda local `users`, `memberships`, `roles`, `bans`, `messages`, `game_sessions` instance DB'sinde tutulur.

### Ilk owner ve ilk server karari

- Self-host setup yalnizca gorunen bir kullanici adi kaydetmez.
- Ayni transaction icinde local owner hesabi (display name, email, Scrypt
  password hash), ilk server, owner membership, admin rolleri ve varsayilan
  kanallar olusur.
- Setup basarili olunca owner oturumu acilir; owner tekrar guest olarak kayit
  olmaz.
- Eski yarim setup kayitlari owner UUID'sini koruyarak bir defaya mahsus
  credential ve server tamamlama akisina girer.
- Production owner claim akisi installer tarafindan uretilen
  `LOBBYFORGE_SETUP_TOKEN` ile korunur.
- Official LobbyForge hesabi daha sonra local hesaba baglanabilir; bu baglama
  local server ownership veya instance yetkilerinin yerini degistirmez.

Official LobbyForge hesabini kullanmak, instance'in local user row'una identity link olusturur. Official hesap instance rollerini, banlarini veya mesajlarini merkezi olarak tasimaz.

## 3. Tek tikla update

Admin panelinden tek tikla update yapilabilir, ama guvenli bir update pipeline'i gerekir. Docker'i bastan kurmak zorunda kalmadan image pull + migration + health check + rollback modeli uygulanir.

### Admin UI

```txt
Admin -> System -> Updates

Current version: 0.4.2
Latest stable: 0.4.3

[Check for updates]
[Update now]
[Schedule maintenance]
[View release notes]
[Rollback last update]
```

### Update akisi

1. Latest release manifest kontrol edilir.
2. Admin release notes ve breaking change uyarilarini gorur.
3. Preflight doctor calisir.
4. Otomatik DB backup alinir.
5. Maintenance mode opsiyonel acilir.
6. Yeni Docker images pull edilir.
7. Migration plan dry-run edilir.
8. Compose rolling/recreate update yapar.
9. Health check ve smoke test calisir.
10. Basarisizsa rollback onerilir veya otomatik rollback yapilir.

### CLI karsiligi

```bash
lfctl update check
lfctl update apply --channel stable
lfctl update rollback
```

### Guvenlik karari

- Auto-update varsayilan kapali olmalidir.
- Admin manuel onay verir.
- Major version upgrade icin ekstra onay gerekir.
- Backup almadan update baslamaz.
- Custom compose/nginx degisiklikleri varsa admin uyarilir.

## 4. Botlar UI'da nasil gozukur?

Botlar normal kullanicidan ayirt edilecek sekilde gosterilmelidir.

### Participant list

```txt
Voice Room
- Ayse
- Mehmet
- Music Bot        [BOT]
- Vampire Narrator [BOT]
```

Bot satirinda:

- bot icon/simgesi
- `BOT` badge
- trust badge: official, verified, unverified
- durum: online, speaking, muted, paused, error
- hover/popover: permissions, owner, current task

### Profile/popover

Bot profili insan profili gibi ama farkli bilgilerle acilir:

- Bot name
- Publisher
- Installed by
- Permissions
- Last activity
- Audit log shortcut
- Disable / configure button, sadece yetkililere

### Mesajlarda

Bot mesajlarinda `BOT` badge ve app icon gosterilir. Moderation/log bot mesajlari sistem renginde, music/game bot mesajlari oda/app baglaminda gorunur.

## 5. Oyun baslatma, oyuncu sayisi ve oda kapasitesi

Oyun sadece oda ayarlarindan baslatilmamali. Gunluk kullanimda yetkili kisi ses odasinin icinden baslatabilmelidir.

### Baslatma yuzeyleri

1. **Voice room toolbar:** hizli "Start Activity" butonu.
2. **Room settings:** bu odada hangi oyunlar kullanilabilir, limitler, roller.
3. **Server app settings:** app install/configure, default settings.
4. **Scheduled events:** ileri asamada planli oyun gecesi.

### Yetki modeli

- `activity.start`
- `activity.stop`
- `activity.manage`
- `activity.configure`
- `activity.invite_players`
- app-specific: `activity.start.hushle`, `activity.start.werewolf`

### Oyuncu sayisi modeli: hibrit

Hibrit model secilmeli:

1. App manifest min/max oyuncu araligini soyler.
2. Oda ayarlari instance/admin limitini soyler.
3. Host oyun baslatirken hedef oyuncu sayisi veya mode secer.
4. Oyun lobby fazinda katilanlara gore kendini ayarlar.
5. Fazla kisi varsa spectator/queue/overflow davranisi devreye girer.

Ornek:

```txt
Hushle manifest: min 4, max 12
Room limit: 20 voice participant
Host choice: max players 8

Voice room'da 13 kisi var:
- ilk 8 kisi player
- kalan 5 kisi spectator
- host isterse oyuncu/secim daveti yapar
```

### Fazla kisi icin karar

Her app manifestte overflow policy tanimlar:

```json
{
  "minPlayers": 4,
  "maxPlayers": 12,
  "defaultMaxPlayers": 8,
  "overflowPolicy": "spectator",
  "supportsQueue": true,
  "supportsSpectators": true
}
```

Policy secenekleri:

- `spectator`: fazla kullanicilar izleyici olur.
- `queue`: fazla kullanicilar siraya girer.
- `split`: ileri asamada otomatik ikinci oda/session onerilir.
- `reject`: oyuncu limiti dolunca katilim kapanir.

## 6. Oyun baslayinca HUD / overlay nasil olmali?

Oyun UI'i tek mod olmamali. Kullanici ayni session icin farkli gorunum secmelidir.

### Gorunum modlari

1. **Docked panel**
   - App icinde orta panel veya sag panel.
   - Desktop/web varsayilan.

2. **Fullscreen activity**
   - Oyun odakli tam ekran.
   - Hushle, Quiz, Vampire Village gibi oyunlar icin ideal.

3. **Compact overlay HUD**
   - Voice controls ustunde kucuk HUD.
   - Timer, skor, siradaki oyuncu, mute/phase gibi hizli bilgiler.

4. **Picture-in-picture / floating overlay**
   - Electron icin ileri asama.
   - Oyun oynarken push-to-talk ve game state'i kucuk pencerede gosterir.

### Karar

MVP:

- Docked panel
- Fullscreen activity
- Compact HUD

Electron ileri asama:

- Always-on-top floating overlay
- global PTT ile birlikte oyun HUD

## 7. Settings yapisi

Settings tek uzun sayfa olmamali; domainlere ayrilmalidir.

### User settings

- Profile: global display name, avatar, banner, status, and per-community nickname
- Account: email/password, linked accounts, sessions
- Privacy: online status, activity visibility, profile visibility, DM policy
- Notifications: mentions, game invites, desktop/mobile/email
- Voice & Video: input/output device, volume, noise suppression, PTT
- Keybinds: user-editable keyboard/mouse shortcuts, persisted per account
- Appearance: theme, density, language
- Activity Status: oynanan oyun, dinlenen muzik, watch party, custom status
- Data & Privacy: export, delete account, retention info

### Server/community settings

- Overview: name, icon, description
- Access & Auth: open, invite-only, and closed registration modes; guest
  access; SEO indexing/title/description; and a sticky save/reset admin UI.
  Writes are admin-gated, rate-limited, schema-validated, and request-size
  limited.
- Invites: canonical 12-character codes, public metadata/redeem validation,
  active/expired/exhausted filtering, active-link copy protection, and revoke
  confirmation. Invite-only mode requires a valid link before a new person can
  join.
- Roles & Permissions: role create/edit/delete, color, position, and core
  permission toggles are available in the canonical full-screen settings
  surface; mutations go through the guarded roles API.
- Channels: channel create/edit/delete/reorder is available in the canonical
  full-screen settings surface; mutations go through the guarded channels API.
- Members: real member list, server nickname visibility, role filter, search,
  sorting, multi-role assignment, kick, and ban controls are available. These
  actions use guarded membership/moderation APIs and re-check permissions on
  the server.
- Voice & Media: default user limit, push-to-talk preference, start-muted,
  camera, screen-share, and media planning caps are stored per server.
  Camera/screen-share are enforced in the LiveKit token route; hard concurrent
  publisher caps are a later LiveKit room-management pass.
- Apps: installed games/bots/integrations
- Moderation: bans, reports, automod
- Audit Log: authorized append-only event review with actor names, search,
  category filters, metadata inspection, and spreadsheet-safe CSV export.
- Public Registry: listing, tags, health, NSFW, discoverability
- Updates: version, backup, update, rollback

### App settings

- Enabled/disabled
- Allowed channels
- Allowed roles
- Default player limit
- Spectator/queue behavior
- App permissions
- Data retention
- Audit events

## 8. Aktivite gunlugu ve profil activity status

### Canonical settings navigation decision

- User, community admin, and server settings use one shared full-screen modal
  presentation; they are not separate dashboard shells.
- The canonical exit is the top-right close icon. `Escape` performs the same
  action and returns to `/lobby`.
- Only one settings dialog may exist in the React tree. Route layouts own the
  shared shell; page content must not introduce a second header or shell.
- On narrow screens, navigation may scroll horizontally. The content pane is
  the vertical scroll owner so the close action remains fixed and reachable.

Aktivite iki farkli seviyede ele alinmali:

### Private audit/activity log

Kullanici ve admin icin guvenlik/hesap gecmisi:

- login/logout
- joined server
- started game
- installed app
- changed settings
- moderation action
- update applied

Bu log yetkiye bagli gorunur.

### Public activity status

Profilde veya participant listesinde gorunebilen durum:

```txt
Playing Hushle in Ankara Gaming
Listening to Music Bot in Chill Room
Watching Watch Party
In voice: Lobby
```

Privacy ayarlari:

- Show current game
- Show music/listening status
- Show watch party status
- Show server name in activity
- Friends/server members/everyone/nobody

Default privacy:

- Current voice/activity status server members'a gorunebilir.
- Cross-server/global public profile activity varsayilan kapali olmalidir.

## 9. Modern web stack karari

Mevcut kodda `apps/web` Next 15 ve React 18 kullaniyor. 2026 hedefi icin karar:

- Yeni feature development hedefi: Next.js 16 + React 19.2 stable hattina gecis.
- `middleware.ts` yerine Next 16 `proxy.ts` kullanimi tercih edilir.
- Node.js hedefi zaten `>=22`, Next 16 icin yeterlidir.
- Gecis ayri migration/refactor PR'i olarak yapilmalidir.

Migration notlari:

- `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom` guncellenir.
- Next 16 breaking changes icin route params, cookies/headers, image config, cache APIs kontrol edilir.
- Eger `middleware.ts` eklenirse dosya adi `proxy.ts` olmalidir.
- `withApiSecurity` route wrapper kalabilir; global redirect/auth boundary gerekiyorsa `proxy.ts` kullanilir.
- Playwright + Vitest smoke suite update sonrasi calismalidir.

## 10. Implement edilmis ama yeni kararlara gore refactor listesi

Bu liste kod taramasina gore hazirlanmistir; implement turunda tek tek ele alinmalidir.

| Alan | Mevcut durum | Refactor karari |
|---|---|---|
| Web stack | `apps/web` Next `^15.0.3`, React `^18.3.1` | Next 16 + React 19.2 migration planla |
| Proxy/middleware | `withApiSecurity` route wrapper var, global proxy yok | Global request boundary gerekirse `proxy.ts`; route wrapper devam |
| Plugin registry | `apps/web/lib/plugin-registry.ts` sadece `quiz` import ediyor | Hushle/Vampire/Watch Party hazir oldukca registry'ye ekle |
| Activity start | Start/list/read/action/end route var; ayni voice/stage channel'da ikinci aktif session 409 ile reddediliyor | Siradaki refactor Game Shell + HUD tarafinda |
| Activity UI | Generic JSON action panel var | Game Shell + per-plugin renderClient + compact HUD/fullscreen modes |
| Plugin settings | `plugins_enabled` tablo var; host artik install/enabled kontrolu yapiyor ve Server Apps tab'i temel install/config sunuyor | App permission screen ve per-channel/role enforcement sonraki refactor |
| Identity links | Dokumana eklendi, schema kodunda yok | `user_identity_links` Drizzle schema + migration |
| Registry app catalog | Dokumana eklendi, schema kodunda yok | `registry_apps` Drizzle schema + registry UI/API |
| Auth policy | Server Access & Auth policy schema/API/UI temeli var | Join enforcement, identity-link flow ve registry visitor handoff sonraki refactor |
| One-click update | `pnpm lfctl update check/plan`, `pnpm lfctl backup verify`, `/admin/updates`, `/admin/updates/{runId}`, `/api/admin/updates`, Ed25519 manifest signature status, backup manifest gate, dry-run/apply/rollback runner preview, non-executing worker contract, command allowlist gate, structured command descriptor, explicit no-shell process runner, sequential worker orchestration, bounded stdout/stderr capture, shared worker event recorder, central execution policy gate, gated apply/rollback endpoint wiring, admin UI confirmation controls, `system_update_runs` history/detail modeli, `system_update_events` event timeline ve maintenance mode runtime guard var; admin execution iki env flag + body execute + tum gate'ler arkasinda | Maintenance/backup controls in update panel |
| Bot UI | `bots` query helper, `/api/servers/{id}/bots`, Server Bots tab ve LiveKit participant `BOT` badge temeli var | Bot profile/popover, message badge, audit shortcut ve configure/disable actionlari sonraki refactor |
| Activity status | `user_settings` helper, `/api/settings/me`, `/settings` privacy/activity visibility UI ve presence reader privacy filtresi var | Profil/participant rich activity text ve friends graph entegrasyonu sonraki refactor |

## 11. Ilk implement sirasi onerisi

1. Maintenance/backup controls in update panel.
2. Next 16 + React 19.2 migration.
3. Bot profile/popover + message badge + configure/disable actions.
4. Friends graph + rich profile activity text.
