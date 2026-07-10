# 23 — Checklistler

## 1. MVP başlamadan önce

- [ ] repo oluşturuldu
- [ ] pnpm workspace
- [ ] README taslağı
- [ ] docs eklendi
- [ ] license seçildi
- [ ] .env.example
- [ ] Docker dev compose
- [ ] PostgreSQL çalışıyor
- [ ] Redis çalışıyor
- [ ] LiveKit çalışıyor
- [ ] Nginx config taslağı

## 2. Voice test checklist

- [ ] token endpoint çalışıyor
- [ ] room name doğru
- [ ] user identity doğru
- [ ] LiveKit WSS bağlanıyor
- [ ] mic permission alınıyor
- [ ] iki client birbirini duyuyor
- [ ] mute çalışıyor
- [ ] deafen çalışıyor
- [ ] leave cleanup çalışıyor
- [ ] Redis presence güncelleniyor

## 3. Text chat checklist

- [ ] mesaj DB’ye yazılıyor
- [ ] mesaj listeleniyor
- [ ] realtime broadcast
- [ ] permission kontrolü
- [ ] rate limit
- [ ] edit/delete planlandı
- [ ] audit optional

## 4. Plugin checklist

- [ ] manifest var
- [ ] enable/disable var
- [ ] GameSession oluşuyor
- [ ] state server-authoritative
- [ ] action validation
- [ ] Redis cache
- [ ] PostgreSQL persistence
- [ ] locale dosyası
- [ ] permission kontrolü

## 5. Hushle checklist

- [ ] activity start
- [ ] lobby
- [ ] takım
- [ ] kart
- [ ] timer
- [ ] skor
- [ ] correct/pass
- [ ] oyun sonu

## 6. Vampir Köylü checklist

- [ ] activity start
- [ ] character create
- [ ] role assign
- [ ] role reveal
- [ ] night phase
- [ ] vampire chat
- [ ] day phase
- [ ] voting
- [ ] spectator
- [ ] game over

## 7. Installer checklist

- [ ] OS check
- [ ] Docker install/check
- [ ] Compose install/check
- [ ] domain prompt
- [ ] .env generate
- [ ] secrets generate
- [ ] Nginx config
- [ ] TLS
- [ ] containers up
- [ ] health check
- [ ] setup wizard

## 8. Security checklist

- [ ] passwords Argon2id
- [ ] secrets server-side
- [ ] PostgreSQL internal only
- [ ] Redis internal only
- [ ] HTTPS
- [ ] WSS
- [ ] rate limit
- [ ] audit log
- [ ] backup docs
- [ ] SECURITY.md

## 9. Public directory checklist

- [ ] manifest endpoint
- [ ] domain verification
- [ ] signed heartbeat
- [ ] official registry UI
- [ ] third-party warning
- [ ] report
- [ ] blocklist
- [ ] NSFW flag
- [ ] version check

## 10. Release checklist

- [ ] changelog
- [ ] migration tested
- [ ] backup tested
- [ ] install fresh VPS tested
- [ ] upgrade tested
- [ ] docs updated
- [ ] demo video
- [ ] GitHub release

## 11. Access/Auth policy checklist

- [ ] instance join policy settings
- [ ] local registration enable/disable
- [ ] guest access enable/disable
- [ ] optional Sign in with LobbyForge
- [ ] required Sign in with LobbyForge for registry visitors
- [ ] account linking table/schema
- [ ] admin approval option

## 12. App/game UX checklist

- [ ] Apps/Games/Bots/Integrations catalog language
- [ ] Game Shell
- [ ] per-game module UI
- [ ] voice room Start Activity button
- [ ] room-level allowed games
- [ ] role-level start/manage permissions
- [ ] min/max/default players from manifest
- [ ] spectator/queue/overflow policy
- [ ] compact HUD
- [ ] fullscreen activity mode

## 13. Bot UI checklist

- [ ] BOT badge in participant list
- [ ] bot icon/avatar treatment
- [ ] trust badge: official/verified/unverified
- [ ] bot profile popover
- [ ] bot permissions visible to admins
- [ ] configure/disable/audit shortcuts

## 14. Settings/activity status checklist

- [ ] user profile settings
- [ ] account and linked accounts
- [ ] privacy and activity visibility
- [ ] voice/video settings
- [ ] appearance/language
- [ ] public activity status
- [ ] private activity/audit log
- [ ] server Access & Auth settings
- [ ] installed app settings

## 15. Update/refactor checklist

- [ ] admin Updates page
- [ ] update check
- [ ] release notes display
- [ ] preflight doctor before update
- [ ] backup before update
- [ ] Docker image pull + compose update
- [ ] migration plan/dry-run
- [ ] health check after update
- [ ] rollback last update
- [ ] Next 16 + React 19.2 migration
- [ ] proxy.ts decision applied if global request boundary is needed
