# 11 — Plugin / Activity Sistemi

## 1. Vizyon

LobbyForge’un en önemli farklılaştırıcısı plugin/activity sistemidir.

Ana uygulama şunları sağlar:

- kullanıcı
- oda
- ses
- text
- role/permission
- realtime event
- state API
- timer
- vote
- score

## 1.1 Urun dili: Apps, Games, Bots, Integrations

Kullaniciya "plugin" kelimesi ana kategori olarak gosterilmez. Plugin teknik terimdir. Urun ve registry dili:

```txt
Apps
- Games / Activities: UI acan, voice room'a bagli real-time deneyimler
- Bots: arka plan otomasyonu veya LiveKit participant olarak calisan servisler
- Integrations: dis servis baglantilari
```

Ornekler:

- Games: Hushle, Vampire Village, Quiz, Watch Party
- Bots: moderation, welcome, role, log, music
- Integrations: YouTube, Twitch, GitHub, Steam, OBS

## 1.2 Game Shell + Game Module modeli

Oyun UI'lari tek dev panel icinde `if game === ...` modeliyle buyutulmemelidir. Dogru model:

```txt
Game Platform Core
- Game session service
- Permission/capability checks
- Voice API adapter
- Realtime event bus
- Shared Game Shell UI
- Game modules
  - hushle
  - vampire-village
  - quiz
  - watch-party
```

Game Shell sunlari saglar:

- oyun adi, host, room bilgisi
- player/spectator listesi
- voice status
- start/stop/reconnect/leave controls
- permission denied/loading/error states
- mobile layout ve participants drawer

Game Module sadece oyuna ozel UI ve reducer/state mantigini saglar.

## 1.3 Activity session kurallari

MVP kural:

```txt
1 voice room = 1 active activity session
```

Ayni odada ayni anda Hushle + Quiz + Watch Party calismaz. Bu karar voice mute/deafen state'ini, LiveKit data channel routing'i ve host controls davranisini basit tutar.

Her activity session server-authoritative state kullanir. Client action yollar; backend permission, phase ve payload validation yapar; yeni state'i broadcast eder.

Pluginler bu altyapının üstünde oyun/aktivite çalıştırır.

## 2. İlk aşama

İlk sürümde rastgele dış plugin yüklenmez.

Sadece official pluginler:

- hushle
- vampire-village
- quiz
- watch-party
- music-room prototype

Neden?

- güvenlik
- veri bütünlüğü
- DB erişimi
- zararlı kod riski
- kaynak tüketimi

## 3. Plugin manifest

```ts
type PluginManifest = {
  id: string;
  name: string;
  version: string;
  type: "game" | "activity" | "utility";
  minAppVersion: string;
  permissions: PluginPermission[];
  locales: string[];
  entryClient: string;
  entryServer?: string;
};
```

## 4. Plugin izinleri

Örnek izinler:

```txt
read_room_participants
send_room_message
create_game_session
manage_game_session
use_voice_state
send_data_channel_event
manage_timer
manage_scores
play_audio_as_bot
read_plugin_settings
write_plugin_settings
```

Izinler capability bazli olmalidir; "admin" gibi genis izin tek tikla verilmez. Install ekraninda izinler kullanici diline cevrilir:

```txt
This app wants to:
- Read voice room participants
- Create and manage game sessions
- Store game state and scores
- Send game messages to the room
```

Dis hesap gerektiren app'ler manifestte bunu acikca belirtir:

```json
{
  "externalAccountRequired": true,
  "externalAccountProvider": "twitch",
  "externalAccountReason": "Needed to sync Twitch subscriber roles"
}
```

Bu durumda LobbyForge auth yerine gecmez; sadece ilgili integration icin kullanici account linking yapar.

## 5. Plugin state

State server-authoritative olmalıdır.

Client sadece action yollar.

Örnek:

```ts
type GamePlugin = {
  manifest: PluginManifest;
  createInitialState(ctx): GameState;
  handleAction(ctx, state, action): GameState;
  renderClient(props): ReactNode;
};
```

## 6. Plugin storage

Üç katman:

### PostgreSQL

Kalıcı:

- plugin settings
- game sessions
- game results
- audit events
- card packs
- scenario packs

### Redis

Geçici:

- timer
- live vote cache
- active player state
- typing/speaking state
- pub/sub events

### Client local state

UI only:

- modal open/closed
- selected tab
- animation state
- input draft

## 7. Plugin lifecycle

1. Plugin enabled
2. Activity selected
3. Session created
4. Lobby phase
5. Running phase
6. Paused optional
7. Ended
8. Result saved
9. Summary shown

## 8. Activity start UI

Voice channel içinde:

```txt
Start Activity
  - Hushle
  - Vampir Köylü
  - Quiz
  - Watch Party
```

Yetki kontrolü:

- owner/admin
- Game Master role
- plugin-specific permission

Baslatma sadece oda ayarlarindan yapilmaz. Gunluk kullanimda yetkili kisi voice room toolbar icinden "Start Activity" kullanir. Oda ayarlari ise hangi oyunlarin kullanilabilecegini, default player limitlerini, spectator/queue davranisini ve hangi rollerin baslatabilecegini belirler.

Oyuncu sayisi modeli hibrittir:

- app manifest `minPlayers`, `maxPlayers`, `defaultMaxPlayers` verir
- room/server settings limit ve izinleri verir
- host baslatirken mode veya hedef max player secer
- oyun lobby fazinda katilan oyuncu sayisina gore kendini ayarlar
- fazla kullanici varsa app manifestteki `overflowPolicy` uygulanir: `spectator`, `queue`, `split`, `reject`

Ornek:

```txt
Hushle max players: 8
Voice room'da 13 kisi var
=> 8 player, 5 spectator veya queue
```

## 9. Plugin UI yerleşimi

Oda içi layout:

```txt
Left: server/channel list
Center: plugin/activity panel
Right: voice participants + game controls
Bottom: voice controls
```

Mobilde:

- tabs
- activity full-screen
- participants drawer
- voice controls sticky bottom

## 9.1 HUD ve overlay modlari

Oyun baslayinca UI tek modda kilitlenmez.

MVP gorunumleri:

- **Docked panel:** app icinde ana oyun paneli
- **Fullscreen activity:** oyunu tam ekran oynama
- **Compact HUD:** voice controls ustunde timer/skor/phase/sira bilgisi

Tauri ileri asama:

- always-on-top floating overlay
- global PTT ile birlikte kucuk oyun HUD

Her game module ayni Game Shell icinde bu gorunumleri desteklemelidir. Module sadece oyuna ozel icerigi render eder; shell host controls, voice status, leave/reconnect, spectator bar ve permission states'i saglar.

## 10. Community plugin ilerisi

İleri aşamada:

- manifest validation
- signed plugin package
- sandbox
- permission review
- plugin marketplace
- external containerized plugin service
- install/enable/disable UI

## 11. Plugin API örnekleri

```ts
ctx.players.list()
ctx.messages.sendGameMessage()
ctx.state.save()
ctx.cache.set()
ctx.pubsub.publish()
ctx.timer.start()
ctx.votes.create()
ctx.scores.add()
ctx.voice.getParticipants()
```

## Development Strategy: Extract, Don't Design

> **Important:** Phases 3 (Plugin SDK) and 4 (Hushle) should be developed together, not sequentially.

The Plugin SDK should be **extracted from working plugin code**, not designed in isolation:

1. **Phase 3+4 combined:** Build Hushle with inline game logic and direct API calls
2. **Extract patterns:** Identify reusable patterns (state management, timer, scoring, chat)
3. **Create SDK:** Extract these patterns into `packages/plugin-sdk`
4. **Validate:** Build Vampire Village using the SDK — if it doesn't fit, refine the SDK
5. **Stabilize:** After 2 plugins work well, document and freeze the SDK API

This follows the "Rule of Three" — don't abstract until you have at least 2-3 concrete examples.

### Plugin Test Harness

The Plugin SDK should include a test harness for plugin developers:

```ts
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

const harness = createTestHarness({
  plugin: hushlePlugin,
  players: ['player1', 'player2', 'player3', 'player4'],
  settings: { roundTime: 60, rounds: 3 },
});

// Simulate game flow
await harness.startGame();
await harness.performAction('player1', { type: 'correct' });
expect(harness.getState().scores.teamA).toBe(1);
await harness.advanceTimer(60); // simulate timer expiry
expect(harness.getState().phase).toBe('between_rounds');
```

### Plugin Data Channel Protocol

Plugins communicate via LiveKit Data Channel (see `24_REALTIME_STRATEGY.md`):

- **Client → Server:** `{ type: 'game:action', payload: { action: 'correct' } }` via RELIABLE
- **Server → Clients:** `{ type: 'game:state', payload: { phase: 'round', scores: {...} } }` via RELIABLE
- **Ephemeral:** `{ type: 'game:typing', payload: { userId: '...' } }` via LOSSY

Plugins do NOT open their own connections — they use the room's existing LiveKit data channel.

## 12. Production migration ownership

- Host tablo/kolon/index degisiklikleri yalnizca `packages/db/drizzle` altindaki
  journaled SQL migration'lariyla yapilir ve web baslamadan once `db:migrate`
  calisir.
- Official plugin/game/bot/tool veri migration'lari `component_migrations`
  ledger'inda `componentType + componentId + version + checksum` ile izlenir.
- Surumler 1'den baslar ve kesintisiz ilerler. Uygulanmis migration degistirilirse
  checksum uyusmazligi deployment'i durdurur; eski migration duzeltilmez, yeni
  surum eklenir.
- Her adim transaction ve PostgreSQL advisory lock icinde calisir. Birden fazla
  web replica ayni migration'i iki kere uygulayamaz.
- Community plugin'e keyfi SQL veya migration callback yetkisi verilmez. Bu
  yetenek official/host tarafinda derlenmis ve incelenmis kodla sinirlidir.
- Hushle built-in kart paketleri bu modelin ilk gercek kaydidir: `game:hushle:v1`.
