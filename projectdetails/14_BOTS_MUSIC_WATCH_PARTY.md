# 14 — Botlar, Müzik ve Watch Party

## 1. Bot vizyonu

LobbyForge’da botlar ileride ekosistemi büyüten ana parçalardan biri olabilir.

Bot örnekleri:

- welcome bot
- moderation bot
- music bot
- game host bot
- quiz bot
- AI narrator
- watch party sync bot
- translation bot

## 2. Bot tipleri

### Internal bot

Core sistemle gelir.

Örnek:

- system bot
- welcome bot
- notification bot

### Plugin bot

Plugin’in parçasıdır.

Örnek:

- Hushle host bot
- Vampir Köylü narrator bot
- Quiz master bot

### External bot service

Ayrı process/container olarak çalışır.

Örnek:

- music bot
- AI bot
- advanced moderation bot

## 3. Bot izinleri

```txt
read_messages
send_messages
join_voice
publish_audio
read_presence
moderate_messages
manage_game_session
manage_music_queue
read_audit_log
```

## 3.1 Botlar UI'da nasil gozukur?

Botlar normal kullanicidan ayirt edilecek sekilde gosterilir.

Participant list:

```txt
Voice Room
- Ayse
- Mehmet
- Music Bot        [BOT]
- Vampire Narrator [BOT]
```

Bot UI kurallari:

- bot icon/simgesi vardir
- `BOT` badge zorunludur
- trust badge gosterilir: official, verified, unverified
- durum gosterilir: online, speaking, muted, paused, error
- hover/popover icinde publisher, installed by, permissions ve current task gorunur
- yetkili kullanicilara configure/disable/audit log kisayollari gorunur

Mesajlarda bot avatarinda bot simgesi, isim yaninda `BOT` badge ve gerekiyorsa app icon gosterilir.

### Uygulama notu

Temel gorunurluk katmani eklendi:

- `packages/db/src/queries/bots.ts` server botlarini listeler.
- `/api/servers/{id}/bots` server uyelerine bot listesini verir.
- Server detayinda `bots` tab'i `BOT`, trust, enabled/disabled, token ve permission bilgilerini gosterir.
- LiveKit participant metadata'sinda `kind: "bot"` veya `bot: true` varsa voice room participant listesinde `BOT` badge gosterilir. `bot:` identity prefix'i de bot olarak kabul edilir.

Siradaki parcalar: bot profile/popover, mesajlarda bot badge, audit log kisayolu ve yetkili kullanicilar icin configure/disable actionlari.

## 4. Bot token güvenliği

- token sadece oluşturulurken gösterilir
- DB’de token hash tutulur
- bot izinleri sınırlanır
- audit log zorunlu
- rate limit uygulanır

## 5. Music bot

### Model A: Bot LiveKit participant olur

Bot odaya kullanıcı gibi girer ve audio track publish eder.

Artıları:

- kullanıcı deneyimi doğal
- herkes aynı sesi duyar
- voice oda mantığına uygun

Eksileri:

- sunucu bandwidth tüketir
- telif riski dikkat ister

### Model B: Client-side sync playback

Her client aynı kaynağı kendi oynatır.

Artıları:

- sunucu bandwidth daha az
- büyük odalar için daha uygun

Eksileri:

- senkronizasyon karmaşık
- kaynak erişimi herkeste aynı olmalı

### Karar

MVP’de music bot ana hedef değildir. Önce bot mimarisi hazırlanır.

Güvenli başlangıç:

- izinli/royalty-free ambience
- kullanıcı kendi yasal stream URL’sini verir
- local file streaming yok veya admin-only

## 6. Watch Party

### Basit mod: screen share

Bir kullanıcı ekranını paylaşır. Herkes izler.

Artı:

- en hızlı
- her platformda anlaşılır

Eksi:

- kalite/bandwidth
- telif sorumluluğu kullanıcıda

### Sync playback modu

Herkes aynı medya kaynağını kendi client’ında oynatır. Host play/pause/seek yapar.

Kullanım:

- YouTube embed sync
- HLS stream sync
- self-hosted legal media sync

### Shared browser

Çok ileri özellik.

MVP’ye alınmaz.

## 7. Watch Party plugin MVP

- room activity başlat
- host seç
- screen share öner
- chat paneli
- play/pause event taslağı
- participant ready state
- basic sync clock

## 8. Telif politikası

LobbyForge telifli içerik dağıtım platformu olmamalıdır.

Dokümantasyon:

- kullanıcı kendi içeriğinden sorumludur
- official music bot telifli kaynaklardan izinsiz stream yapmaz
- public directory abuse durumunda işlem yapılabilir

## 9. AI bot fikirleri

İleri:

- Vampir Köylü narrator
- quiz question generator
- toplantı özeti
- moderation suggestion
- onboarding assistant
- live translation
- oyun hikaye anlatıcısı

AI botlarda gizlilik ayarı şarttır.
