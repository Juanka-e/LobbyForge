# 06 — PostgreSQL Veri Modeli

## 1. Genel karar

LobbyForge varsayılan DB olarak PostgreSQL kullanır.

Kalıcı veriler PostgreSQL’e yazılır. Redis sadece geçici/cache/pubsub katmanıdır.

## 2. Şema yaklaşımı

İlk aşamada tek PostgreSQL database:

```txt
database: lobbyforge
schema: public
```

İleride büyük kurulumlarda ayrı schema’lar düşünülebilir:

```txt
core.*
plugins.*
registry.*
audit.*
```

## 3. Temel tablolar

### users

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  banner_url TEXT,
  locale TEXT DEFAULT 'en',
  is_guest BOOLEAN DEFAULT FALSE,
  status_text VARCHAR(128),                -- custom status message
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ                   -- soft delete for GDPR/KVKK
);
```

### user_identity_links

Optional "Sign in with LobbyForge" veya dis OAuth provider baglantilari icin local instance icinde tutulur.

```sql
CREATE TABLE user_identity_links (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE(provider, provider_subject),
  UNIQUE(user_id, provider)
);
```

Bu tablo official hesabin local user yerine gecmesi icin degil, local user row'una guvenli sekilde linklenmesi icindir.

### servers

```sql
CREATE TABLE servers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  icon_url TEXT,
  default_locale TEXT DEFAULT 'en',
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ                   -- soft delete
);
```

### channels

```sql
CREATE TABLE channels (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'activity', 'announcement', 'stage')),
  position INTEGER NOT NULL DEFAULT 0,
  plugin_id TEXT,
  topic VARCHAR(512),                      -- channel topic/description
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### roles

```sql
CREATE TABLE roles (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### memberships

```sql
CREATE TABLE memberships (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id),
  nickname TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(server_id, user_id)
);
```

### messages

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,  -- message replies
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
```

## 4. Plugin tabloları

### server_voice_settings

```sql
CREATE TABLE server_voice_settings (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE UNIQUE,
  default_user_limit INTEGER,
  require_push_to_talk BOOLEAN NOT NULL DEFAULT FALSE,
  start_muted BOOLEAN NOT NULL DEFAULT FALSE,
  allow_camera BOOLEAN NOT NULL DEFAULT TRUE,
  allow_screen_share BOOLEAN NOT NULL DEFAULT TRUE,
  max_camera_users_per_room INTEGER,
  max_screen_share_users_per_room INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`allow_camera` and `allow_screen_share` are enforced by the LiveKit token route
by narrowing `canPublishSources`. Capacity fields are stored as planning caps;
hard concurrent publisher enforcement belongs to the later LiveKit room
management pass.

### plugins_enabled

```sql
CREATE TABLE plugins_enabled (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(server_id, plugin_id)
);
```

### game_sessions

```sql
CREATE TABLE game_sessions (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'running', 'paused', 'ended', 'cancelled')),
  state JSONB NOT NULL DEFAULT '{}',
  public_summary JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
```

### game_session_players

```sql
CREATE TABLE game_session_players (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_name TEXT,
  character_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  score INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ
);
```

### plugin_events

```sql
CREATE TABLE plugin_events (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES game_sessions(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 5. Bot tabloları

### bots

```sql
CREATE TABLE bots (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  token_hash TEXT,
  permissions JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 6. Public directory tabloları

### instance_settings

```sql
CREATE TABLE instance_settings (
  id UUID PRIMARY KEY,
  instance_id TEXT UNIQUE NOT NULL,
  instance_name TEXT NOT NULL,
  domain TEXT,
  public_key TEXT,
  private_key_encrypted TEXT,
  region TEXT,
  languages JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  is_public_directory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### registry_instances

Registry servisinde:

```sql
CREATE TABLE registry_instances (
  id UUID PRIMARY KEY,
  instance_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT,
  region TEXT,
  languages JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  features JSONB NOT NULL DEFAULT '[]',
  public_key TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_listed BOOLEAN NOT NULL DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  nsfw BOOLEAN NOT NULL DEFAULT FALSE,
  online_users INTEGER NOT NULL DEFAULT 0,
  public_rooms_count INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  doctor_score INTEGER,
  last_heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### registry_apps

Registry servisinde public app catalog icin:

```sql
CREATE TABLE registry_apps (
  id UUID PRIMARY KEY,
  app_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('game', 'bot', 'integration')),
  publisher_account_id UUID,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('official', 'verified-community', 'unverified')),
  version TEXT NOT NULL,
  summary TEXT,
  permissions JSONB NOT NULL DEFAULT '[]',
  manifest JSONB NOT NULL DEFAULT '{}',
  external_account_required BOOLEAN NOT NULL DEFAULT FALSE,
  compatible_app_version TEXT,
  is_listed BOOLEAN NOT NULL DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Registry app kaydi sadece katalog metadata'sidir. App install, app settings, bot secrets ve game state instance DB'sinde kalir.

## 7. Audit log

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 8. Telemetry snapshot

```sql
CREATE TABLE telemetry_snapshots (
  id UUID PRIMARY KEY,
  instance_id TEXT NOT NULL,
  cpu JSONB NOT NULL DEFAULT '{}',
  memory JSONB NOT NULL DEFAULT '{}',
  disk JSONB NOT NULL DEFAULT '{}',
  network JSONB NOT NULL DEFAULT '{}',
  livekit JSONB NOT NULL DEFAULT '{}',
  redis JSONB NOT NULL DEFAULT '{}',
  postgres JSONB NOT NULL DEFAULT '{}',
  recommendation JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 9. Invite System, Session Management & Supporting Tables

### invites

```sql
-- =============================================
-- INVITE SYSTEM
-- =============================================
CREATE TABLE invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  code          VARCHAR(16) UNIQUE NOT NULL,
  max_uses      INTEGER,                    -- NULL = unlimited
  current_uses  INTEGER DEFAULT 0,
  expires_at    TIMESTAMPTZ,                -- NULL = never expires
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### user_sessions

```sql
-- =============================================
-- SESSION MANAGEMENT
-- =============================================
CREATE TABLE user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(256) NOT NULL,       -- hashed session token
  ip_address    INET,
  user_agent    TEXT,
  last_active   TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### user_settings

```sql
-- =============================================
-- USER SETTINGS (per-user preferences)
-- =============================================
CREATE TABLE user_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme         VARCHAR(32) DEFAULT 'system',  -- 'light' | 'dark' | 'system'
  notifications JSONB DEFAULT '{}',           -- {mentions: true, sounds: true, ...}
  audio         JSONB DEFAULT '{}',           -- {inputDevice: null, outputDevice: null, inputVolume: 100, ...}
  privacy       JSONB DEFAULT '{}',           -- {showOnlineStatus: true, allowDMs: true, ...}
  keybinds      JSONB DEFAULT '{}',           -- {pushToTalk: 'Space', muteMic: 'M', ...}
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### server_auth_settings

Self-host instance veya community bazinda giris politikasini tutar.

```sql
CREATE TABLE server_auth_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID UNIQUE NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  join_policy TEXT NOT NULL DEFAULT 'invite_only',
  allow_guest BOOLEAN NOT NULL DEFAULT TRUE,
  allow_local_registration BOOLEAN NOT NULL DEFAULT TRUE,
  lobbyforge_login_mode TEXT NOT NULL DEFAULT 'off',
  require_approval BOOLEAN NOT NULL DEFAULT FALSE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

`lobbyforge_login_mode` degerleri:

```txt
off
optional
required_for_registry_visitors
required_for_all
```

### user_activity_events

Private activity log ve public activity status icin ham event kaydi.

```sql
CREATE TABLE user_activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Public profil activity status bu eventlerden veya Redis presence snapshot'larindan turetilebilir. Varsayilan global public activity kapali olmalidir.

### server_bans

```sql
-- =============================================
-- MODERATION: SERVER BANS
-- =============================================
CREATE TABLE server_bans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT,
  expires_at    TIMESTAMPTZ,                -- NULL = permanent
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(server_id, user_id)
);
```

### reactions

```sql
-- =============================================
-- MESSAGE REACTIONS
-- =============================================
CREATE TABLE reactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji         VARCHAR(64) NOT NULL,        -- unicode emoji or custom emoji id
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(message_id, user_id, emoji)
);
```

### attachments

```sql
-- =============================================
-- FILE ATTACHMENTS
-- =============================================
CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID REFERENCES messages(id) ON DELETE CASCADE,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  filename      VARCHAR(512) NOT NULL,
  mime_type     VARCHAR(128) NOT NULL,
  size_bytes    BIGINT NOT NULL,
  storage_path  TEXT NOT NULL,               -- relative path in /data/uploads/
  width         INTEGER,                     -- for images/video
  height        INTEGER,                     -- for images/video
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

## 10. Mesaj şifreleme kararı

MVP'de mesajlar PostgreSQL'de plaintext tutulur.

Neden:

- text chat araması
- moderation
- report
- audit
- plugin entegrasyonu
- export
- backup/restore

Ama dokümantasyonda açıkça belirtilmelidir:

> Self-host instance admini teknik olarak kendi sunucusundaki mesajlara erişebilir.

Parolalar asla plaintext tutulmaz. Parola hash için Argon2id önerilir.

## 11. Index önerileri

```sql
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX idx_memberships_server_user ON memberships(server_id, user_id);
CREATE INDEX idx_game_sessions_server_channel ON game_sessions(server_id, channel_id);
CREATE INDEX idx_plugin_events_session_created ON plugin_events(session_id, created_at DESC);
CREATE INDEX idx_audit_logs_server_created ON audit_logs(server_id, created_at DESC);
CREATE INDEX idx_registry_instances_listed ON registry_instances(is_listed, is_blocked, last_heartbeat_at DESC);
CREATE INDEX idx_invites_server ON invites(server_id);
CREATE INDEX idx_invites_code ON invites(code);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX idx_server_bans_server_user ON server_bans(server_id, user_id);
CREATE INDEX idx_reactions_message ON reactions(message_id);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_messages_reply ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
```

## 12. Soft Delete & Data Retention

### Soft Delete Policy

Users and servers use soft delete via the `deleted_at` column. When a user is deleted:

- `display_name` → set to `'Deleted User'`
- `email` → replaced with an anonymized hash
- `password_hash` → cleared (set to NULL)
- `avatar_url` → set to NULL
- Messages remain in the database, but the author displays as **"Deleted User"**
- Memberships are removed (hard deleted)
- All active sessions are invalidated (deleted from `user_sessions`)
- Game results (`game_session_players`) are preserved for data integrity

This approach satisfies GDPR/KVKK "right to erasure" requirements while maintaining referential integrity for historical records (game scores, audit trails).

### Data Retention Defaults

| Data Type | Retention Period | Action |
|---|---|---|
| Messages | Unlimited | Admin or user can delete individually |
| Audit Logs (`audit_logs`) | 90 days | Archive to cold storage, then delete |
| Telemetry Snapshots (`telemetry_snapshots`) | 30 days | Delete |
| Game Sessions — ended (`game_sessions`) | 1 year | Archive to cold storage, then delete |
| Plugin Events (`plugin_events`) | 30 days | Delete |
| User Sessions — expired (`user_sessions`) | 7 days | Delete |

Retention is enforced by a scheduled cleanup job (cron or pg_cron). Archival targets cold storage (e.g., compressed JSON exports to `/data/archive/` or S3).
