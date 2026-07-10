# 09 — Auth, Güvenlik ve Gizlilik

## 1. Hesap modelleri

## 0. Karar: hesap modeli ve cross-instance auth

LobbyForge MVP'de tek global kullanici veritabani uzerine kurulmaz. Kimlik modeli su sekilde ayrilir:

- **Official LobbyForge account:** lobbyforge.org, official registry, app/developer portal, official community hub, desktop profile sync ve billing/donation gibi merkezi ozellikler icindir.
- **Local instance account:** bir self-host instance'a giren kullanicinin asil uyelik, rol, ban, mesaj, oyun gecmisi ve audit kaydi o instance'in DB'sinde tutulur.
- **Guest identity:** invite ile hizli katilim icindir; instance local DB'sinde guest user olarak materialize edilir.

Varsayilan davranis:

```txt
Kullanici official app'e kaydolur -> official hub ve registry profilini kullanir.
Kullanici voice.example.com'a gider -> o instance'in local login/register/guest politikasina uyar.
Kullanici baska instance'a gider -> tekrar guest/register gerekebilir.
```

Bu kasitli bir karardir. Aksi halde registry merkezi bir identity authority haline gelir ve self-host/privacy vaadi zayiflar.

### Optional "Sign in with LobbyForge"

Instance sahibi isterse official LobbyForge hesabini bir OAuth/OIDC provider gibi kabul edebilir.

Bu secenek acildiginda:

1. Kullanici "Sign in with LobbyForge" ile girer.
2. Instance official provider'dan sadece gerekli claims alir: `sub`, display name, avatar, verified email opsiyonel.
3. Instance kendi `users` tablosunda local row olusturur veya mevcut row'a linkler.
4. Membership, roles, bans, permissions, messages ve game history yine instance DB'sinde kalir.

Bu secenek kapaliysa kullanici local register veya guest flow ile devam eder.

### Registry app owner auth policy

Registry'deki app sahipleri kullanici auth modelini tek tarafli ele geciremez.

- Official apps: LobbyForge instance auth'unu kullanir, ek hesap istemez.
- Verified community apps: instance auth'unu kullanir; gerekiyorsa dis servis baglantisi icin acik bir "Connect account" OAuth flow'u sunar.
- External integrations: YouTube/Twitch/Steam gibi servisler icin kullanicidan ayrica hesap baglamasini isteyebilir.
- Unverified/self-host apps: instance admini tarafindan acik risk etiketiyle kurulur.

Bir app "bu oyunu oynamak icin benim siteme tekrar kaydol" diyebilir, ama bu default marketplace deneyimi olmamalidir. Boyle app'ler registry'de `external_account_required: true` etiketiyle gosterilir.

### Registry visitor auth policy

Self-host sahibi public registry'ye kaydolsa bile auth kararini kendi verir.

Admin panelde secenek:

```txt
Registry visitors login mode:
- Use this instance's normal login/register rules
- Offer Sign in with LobbyForge as an option
- Require Sign in with LobbyForge for registry visitors
- Require Sign in with LobbyForge for everyone
```

Bu ayar sadece giris deneyimini belirler. Yetki ve veri sahipligi yine instance'a aittir.

### Local instance user

Her self-host instance kendi kullanıcılarını tutar.

```txt
voice.example.com kendi users tablosunu kullanır.
```

### Official registry owner account

Official registry hesabı sadece sunucu sahipleri içindir.

Registry:

- instance metadata tutar
- heartbeat tutar
- public listing tutar

Registry şunları tutmaz:

- başka instance mesajları
- başka instance kullanıcı şifreleri
- başka instance voice/video trafiği

## 2. Guest login

MVP’de guest join olmalıdır.

Guest kullanıcı:

- nickname seçer
- invite ile girer
- kalıcı profil zorunlu değildir
- bazı özellikleri kısıtlanabilir

## 3. Registered user

Registered kullanıcı:

- email
- password hash
- avatar
- role
- stats
- oyun geçmişi
- bot/plugin yetkileri

## 4. Password hashing

Parola plaintext tutulmaz.

Öneri:

```txt
Argon2id default
bcrypt fallback
```

DB’de:

```txt
password_hash
```

## 5. Session

Seçenekler:

- secure httpOnly cookie
- session table
- JWT + refresh token

MVP için öneri:

```txt
httpOnly secure cookie + server-side session
```

Neden:

- revoke kolay
- self-host için yönetilebilir
- XSS riskinde token erişimi zorlaşır

## 6. LiveKit secret güvenliği

LiveKit secret sadece server-side tutulur.

Client tarafına:

- API secret verilmez
- sadece kısa ömürlü token verilir

## 7. DB ve Redis güvenliği

- PostgreSQL dış dünyaya açılmaz
- Redis dış dünyaya açılmaz
- Docker internal network
- backup dosyaları korunur
- `.env` paylaşılmaz
- read-only DB user ayrı oluşturulur

## 8. Mesaj gizliliği

MVP:

- mesajlar PostgreSQL’de plaintext tutulur
- TLS ile aktarım korunur
- DB dışarı kapalıdır

Kullanıcıya açık bilgi:

> Self-host instance admini teknik olarak kendi sunucusundaki mesajlara erişebilir.

İleri özellikler:

- private encrypted rooms
- encrypted DM
- at-rest encryption guide
- backup encryption

## 9. Moderasyon

Temel moderasyon:

- kick
- ban
- mute
- deafen
- role change
- message delete
- invite revoke
- audit log
- report system

## 10. Public directory güvenliği

Official registry’ye girmek için:

- domain zorunlu
- HTTPS zorunlu
- signed heartbeat
- health endpoint
- version bilgisi
- abuse report
- blacklist
- NSFW flag
- third-party warning

## 11. Plugin güvenliği

MVP:

- sadece official pluginler
- pluginler core API üzerinden state değiştirir
- server-authoritative game state
- client actionları doğrulanır

İleri:

- plugin manifest
- permission system
- sandbox
- containerized external plugin services
- marketplace review

## 12. Bot güvenliği

- bot token hashlenir
- bot izinleri sınırlanır
- bot actionları audit log’a düşer
- external bot rate limitlenir
- müzik/watch party telif uyarıları olur

## 13. Security.md içeriği

Repo’da `SECURITY.md` olmalı:

- güvenlik açığı bildirim emaili
- supported versions
- disclosure policy
- secret leak durumunda yapılacaklar
- dependency update politikası

## CORS & Security Headers

### CORS Policy

```nginx
# Nginx CORS configuration
add_header Access-Control-Allow-Origin "https://app.example.com" always;
add_header Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS" always;
add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-Requested-With" always;
add_header Access-Control-Allow-Credentials "true" always;
add_header Access-Control-Max-Age "86400" always;
```

- Only the app domain is allowed (no wildcards in production)
- Credentials included (cookies for session auth)
- Preflight cached for 24 hours
- rtc.example.com has separate CORS (LiveKit handles its own)

### Content Security Policy

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';  # unsafe-eval needed for LiveKit SDK in dev
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob: https://uploads.example.com;
  media-src 'self' blob:;
  connect-src 'self' https://rtc.example.com wss://rtc.example.com;
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
```

### Other Security Headers

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header X-XSS-Protection "0" always;        # Disabled: modern CSP is better
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=()" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

Note: `microphone=(self)` allows mic access only from the app domain (needed for voice).

## CSRF Protection

### Strategy: Double Submit Cookie + SameSite

1. **SameSite=Lax** on session cookie — blocks most cross-origin POST requests automatically
2. **CSRF token** for state-changing operations:
   - Server generates CSRF token, stores in session
   - Token sent to client via meta tag or API response
   - Client includes token in `X-CSRF-Token` header for POST/PATCH/DELETE
   - Server validates token matches session

3. **Origin header check** as additional layer:
   - Reject requests where `Origin` header doesn't match app domain
   - Except for API routes with Bot token auth (external bots)

### Exempt Routes
- LiveKit webhook endpoint (verified by LiveKit signature)
- Registry heartbeat endpoint (verified by instance signature)
- Bot API endpoints (verified by bot token)

## Input Validation

All user input is validated using **Zod** schemas at the API boundary.

### Validation Rules

| Field | Rule |
|---|---|
| Display name | 2-64 chars, trimmed, no control characters |
| Email | Valid email format, lowercase, max 320 chars |
| Password | 8-128 chars, no requirements beyond length (NIST 800-63B) |
| Server name | 2-100 chars, trimmed |
| Channel name | 1-100 chars, trimmed, no # prefix |
| Message content | 1-4000 chars |
| Invite code | 6-16 alphanumeric chars |
| Slug | 2-50 chars, lowercase, alphanumeric + hyphens |

### Sanitization

- **HTML:** Strip all HTML tags from user content. Messages support markdown, not HTML.
- **SQL:** Parameterized queries via Drizzle ORM (no raw SQL interpolation).
- **URLs:** Validate with `URL` constructor. Only `https://` allowed in production.
- **File names:** Strip path separators, control characters. Generate UUID-based storage names.
- **JSON (JSONB fields):** Validate structure with Zod before database insert.

### Rate Limiting by Input

- Failed login attempts: progressive delay (1s, 2s, 4s, 8s... up to 5 min)
- Repeated invalid input: count towards rate limit
- Oversized payloads: rejected by Nginx before reaching app (client_max_body_size)

## GDPR / KVKK / Privacy Compliance

LobbyForge is self-hosted — each instance operator is the data controller. However, the software should make compliance easy.

### User Rights Implementation

| Right | Implementation |
|---|---|
| Right to access | `GET /api/users/me/data-export` — returns all user data as JSON |
| Right to erasure | `DELETE /api/users/me` — soft delete + anonymization |
| Right to portability | Data export includes messages, settings, game history |
| Right to rectification | Users can edit profile, settings at any time |

### Account Deletion Flow

1. User requests deletion → confirmation email/prompt
2. 14-day grace period (can cancel)
3. After grace period:
   - `display_name` → 'Deleted User'
   - `email` → SHA-256 hash (for re-registration prevention)
   - `password_hash` → cleared
   - `avatar_url` → null
   - `status_text` → null
   - `deleted_at` → timestamp
   - Messages remain but show 'Deleted User' as author
   - Memberships removed
   - Sessions invalidated
   - User settings deleted
   - Game session player records: userId anonymized, scores preserved
   - Audit log entries: actor shown as 'Deleted User'
4. Uploaded files (avatar, attachments): queued for deletion

### Data Processing Disclosure

Each instance should display:
- What data is collected (registration info, messages, voice metadata, game history)
- Where data is stored (on the instance server)
- Who has access (instance admin, technical)
- Data retention periods
- Contact info for data requests

Template privacy policy page provided in `apps/web/src/app/privacy/page.tsx`.

### Cookie Consent

MVP: Session cookie is "strictly necessary" — no consent banner needed.
Future: If analytics or tracking added, cookie consent banner required.
