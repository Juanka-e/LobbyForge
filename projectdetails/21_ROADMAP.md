# 21 — Aşama Aşama Geliştirme Planı

## Aşama 0 — Hazırlık

Amaç: repo ve kararları sabitlemek.

Yapılacaklar:

- monorepo oluştur
- docs ekle
- README taslağı
- pnpm workspace
- lint/format
- env örnekleri
- Docker dev compose

Başarı:

- repo klonlanıp `pnpm install` çalışıyor

## Aşama 1 — Teknik spike

Amaç: temel stack çalışsın.

Yapılacaklar:

- Next.js app
- PostgreSQL connection
- Redis connection
- LiveKit local
- Nginx local/prod config taslağı
- basit guest auth
- LiveKit token endpoint
- iki browser voice test

Başarı:

- 2 kullanıcı aynı voice room’da konuşabiliyor

## Aşama 2 — Core community MVP

Yapılacaklar:

- server create
- channel create
- invite link
- guest join
- text chat
- voice user list
- mute/deafen
- basic permission
- messages PostgreSQL
- presence Redis

Başarı:

- küçük arkadaş grubu gerçek kullanım yapabiliyor

## Aşama 3 — Plugin SDK minimal

Yapılacaklar:

- plugin manifest
- plugin registry
- GameSession table
- Start Activity UI
- plugin state/action
- Redis cache layer
- PostgreSQL persistence
- plugin locale loading

Başarı:

- dummy plugin activity olarak açılıyor

## Aşama 4 — Hushle MVP

Yapılacaklar:

- takım
- kart
- yasaklı kelime
- timer
- skor
- host controls
- oyun sonu

Başarı:

- 4-8 kişi sesli Hushle oynuyor

## Aşama 5 — Installer

Yapılacaklar:

- production docker-compose
- Nginx config
- certbot/TLS
- install.sh
- upgrade.sh
- backup.sh
- doctor.sh
- setup wizard

Başarı:

- temiz Ubuntu VPS’e kuruluyor

## Aşama 6 — Doctor

Yapılacaklar:

- service health
- PostgreSQL ping
- Redis ping
- LiveKit health
- Nginx config test
- HTTPS/WSS
- UDP check
- capacity recommendation

Başarı:

- admin sağlıklı rapor görebiliyor

## Aşama 7 — Vampir Köylü MVP

Yapılacaklar:

- lobby
- karakter adı
- rol dağıtma
- gece/gündüz
- vampire private text chat
- public game chat
- voting
- spectator
- game over

Başarı:

- 6-12 kişi oynayabiliyor

## Aşama 8 — Tauri Desktop

Yapılacaklar:

- Tauri 2 media/security spike
- isolated desktop shell + instance webview
- global PTT
- tray
- notification
- device shortcut
- deep-link auth handoff
- signed updater dry-run

Başarı:

- Windows 10/11 desktop app ile PTT çalışıyor

## Aşama 9 — Public directory

Yapılacaklar:

- registry app
- manifest endpoint
- domain verification
- signed heartbeat
- public listing UI
- self-host admin directory settings
- report/block

Başarı:

- başka VPS instance official listede görünüyor

## Aşama 10 — Bot SDK + Watch Party

Yapılacaklar:

- bot token
- bot permissions
- welcome bot
- moderation bot
- watch party screen share
- playback sync prototype
- music bot research

Başarı:

- botlar kontrollü yetkiyle çalışıyor

## Asama 11 - Settings, auth policy ve app catalog polish

Yapilacaklar:

- Access & Auth settings
- optional Sign in with LobbyForge
- local vs official account linking
- App Catalog metadata
- Installed Apps settings
- bot badge/profile UI
- activity status privacy
- compact HUD/fullscreen activity modes

Basari:

- self-host sahibi registry'den gelen kullanicilarin nasil girecegini secebiliyor
- oyunlar voice room icinden dogru izin ve oyuncu limitiyle baslatiliyor
- botlar UI'da insanlardan net ayriliyor

## Asama 12 - Admin update ve web stack migration

Yapilacaklar:

- Admin Updates page
- update check/release notes
- preflight doctor
- automatic backup
- Docker image pull + compose update
- migration plan
- rollback
- Next 16 + React 19.2 migration (completed 2026-07-16)
- `proxy.ts` request boundary karari

Basari:

- admin Docker'i bastan kurmadan guvenli sekilde tek tikla update alabiliyor
- web app modern stable stack ile build/test geciyor
