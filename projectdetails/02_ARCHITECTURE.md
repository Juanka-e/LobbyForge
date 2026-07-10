# 02 — Sistem Mimarisi

## 1. Yüksek seviye mimari

Bileşenler:

- Next.js Web UI/API
- Electron Desktop Wrapper
- PostgreSQL
- Redis
- LiveKit Server
- Nginx Reverse Proxy
- Optional coturn
- Optional registry service
- Optional doctor/metrics service

Basit akış:

```txt
Browser/Electron
   ↓ HTTPS/WSS
Nginx
   ├── web:3000      → Next.js UI/API
   └── livekit:7880  → LiveKit signaling
        ↓ WebRTC ICE/UDP
LiveKit media path
```

Kalıcı veri:

```txt
Next.js API → PostgreSQL
```

Geçici veri:

```txt
Next.js API / workers → Redis
```

Medya:

```txt
Client ↔ LiveKit SFU
```

## 2. Next.js görevleri

Next.js hem UI hem API tarafını taşır.

Görevler:

- Login/register/guest auth
- Server/community oluşturma
- Channel oluşturma
- Text chat
- Role/permission kontrolü
- LiveKit token üretimi
- Plugin session yönetimi
- Bot token yönetimi
- Public directory ayarları
- Doctor raporlarını gösterme
- Admin panel
- JSON i18n

## 3. PostgreSQL görevleri

PostgreSQL kalıcı verinin ana kaynağıdır.

Tutar:

- kullanıcılar
- sunucular
- kanallar
- roller
- üyelikler
- mesajlar
- invite linkleri
- plugin ayarları
- oyun session kayıtları
- oyun sonuçları
- bot ayarları
- public directory ayarları
- audit loglar
- telemetry snapshotları

## 4. Redis görevleri

Redis kalıcı veri tabanı değildir.

Kullanım alanları:

- presence
- online user listesi
- voice room anlık kullanıcı durumu
- rate limit
- pub/sub
- kısa süreli game state cache
- queue
- distributed lock
- typing indicator
- temporary invite throttle
- plugin timer cache

## 5. LiveKit görevleri

LiveKit medya katmanıdır.

Görevler:

- ses
- video
- screen share
- participant/track yönetimi
- audio level
- active speaker
- data channel eventleri
- webhook eventleri

## 6. Nginx görevleri

Nginx dış dünyaya açılan giriş noktasıdır.

Görevler:

- HTTPS termination
- WSS reverse proxy
- app domain routing
- rtc domain routing
- basic security headers
- rate limiting
- request body limit
- static asset caching
- WebSocket upgrade handling
- optional proxy protocol / real IP

## 7. Instance ve registry ayrımı

Her self-host kurulum bir **instance**tır.

Official registry ayrı bir sistemdir:

```txt
Self-host instance:
voice.example.com

Official registry:
lobbyforge.org
```

Registry sadece public instance keşfi sağlar. Başka instance’ın mesajını, şifresini, medya trafiğini tutmaz.

## 8. Plugin mimarisi

Pluginler core sistemden bağımsız activity olarak çalışır.

Core sağlar:

- kullanıcı listesi
- oda bilgisi
- permission
- realtime event transport
- persistent state API
- temporary state API
- timer API
- score API
- chat primitive
- voice state primitive

Plugin örnekleri:

- Hushle
- Vampir Köylü
- Quiz
- Watch Party
- Music Room

## 9. Bot mimarisi

Botlar üç tip olabilir:

1. Internal bot
2. Plugin bot
3. External bot service

Müzik botu veya oyun host botu LiveKit participant gibi odaya katılabilir.

## 10. Önerilen domain yapısı

Self-host instance:

```txt
app.example.com
rtc.example.com
turn.example.com optional
```

Alternatif tek domain path routing daha karmaşık olabilir. Başlangıçta subdomain daha temizdir.

## Session Storage

### Strategy: Redis Primary + PostgreSQL Backup

Session data stored in two layers:

1. **Redis (hot):** Active session lookup on every request. Key: `session:{tokenHash}`. TTL: session expiry time.
2. **PostgreSQL (durable):** `user_sessions` table for audit, multi-device management, forced logout.

### Flow

```
Login → Create session in PG → Cache in Redis → Set httpOnly cookie
Request → Read cookie → Check Redis → (miss?) Check PG → Rebuild Redis cache → Authorize
Logout → Delete from Redis → Mark expired in PG
Password change → Invalidate ALL sessions (Redis + PG)
```

### Why Both?

- Redis alone: session data lost on restart → all users logged out
- PG alone: DB query on every single request → performance bottleneck
- Hybrid: fast reads (Redis), durability (PG), session management UI (PG query)

## Client-Side Architecture

See `26_CLIENT_STATE_MANAGEMENT.md` for details.

### State Management Stack

| Layer | Tool |
|---|---|
| Server state (API data) | TanStack Query |
| Real-time state (presence, voice, game) | Zustand |
| UI state (modals, theme, sidebar) | Zustand (persisted) |
| Form state | React Hook Form + Zod |
| URL state | Next.js router |

### Data Fetching: tRPC

Internal API uses tRPC for end-to-end type safety. External/public API uses REST.
See `29_API_DESIGN_STANDARDS.md` for details.
