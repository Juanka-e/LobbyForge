# 19 — LobbyForge Doctor, Telemetry ve Kapasite

## 1. Amaç

Self-host kullanıcı şu sorulara cevap bulmalı:

- Kurulum doğru mu?
- HTTPS çalışıyor mu?
- WSS çalışıyor mu?
- UDP açık mı?
- LiveKit bağlantı kurabiliyor mu?
- Redis/PostgreSQL sağlıklı mı?
- Sunucum kaç kişiyi kaldırır?
- Video açmalı mıyım?
- Screen share limiti ne olmalı?

## 2. Doctor kontrolleri

### Sistem

- CPU count
- RAM total/free
- disk free
- load average
- swap
- Docker status
- container health

### Network

- DNS resolve
- HTTPS cert
- WSS test
- UDP test
- public IP
- NAT warning
- packet loss optional

### Services

- web health
- PostgreSQL ping
- Redis ping
- LiveKit health
- Nginx config test

### Media

- LiveKit room create test
- token create test
- signaling test
- UDP candidate warning
- TURN optional test

## 3. Doctor output

Örnek:

```txt
LobbyForge Doctor

✅ Nginx running
✅ HTTPS valid
✅ Web app healthy
✅ PostgreSQL reachable
✅ Redis reachable
✅ LiveKit signaling reachable
⚠️ UDP range may be blocked
⚠️ TURN not configured

Recommended profile:
Audio-first community
Max voice users per room: 40
Max camera users per room: 4
Max screen share: 1
Default layout: active speaker
```

## Alerting & Notifications

Doctor runs checks but admin needs to be notified when things go wrong.

### Alert Channels (MVP)

| Channel | How | When |
|---|---|---|
| Admin Panel Banner | In-app notification | Any Doctor warning/error |
| Webhook (Discord/Slack) | POST to configured URL | Critical alerts only |
| Email | SMTP via configured mail server | Optional, critical only |

### Alert Levels

| Level | Trigger | Example | Action |
|---|---|---|---|
| ℹ️ Info | Routine status | Backup completed | Log only |
| ⚠️ Warning | Degraded performance | CPU >70%, disk >80% | Admin banner |
| 🔴 Critical | Service failure | PG down, Redis unreachable | Banner + webhook + email |
| 💀 Fatal | Instance unusable | Disk full, no network | Banner + webhook + email |

### Webhook Payload

```json
{
  "level": "critical",
  "check": "postgresql_health",
  "message": "PostgreSQL connection failed after 3 retries",
  "timestamp": "2026-06-03T20:00:00Z",
  "instanceId": "...",
  "details": { "error": "connection refused", "lastSuccess": "..." }
}
```

### Doctor Schedule

- **Continuous:** Service health ping (every 60s)
- **Periodic:** Full Doctor report (every 15 minutes)
- **On-demand:** Admin clicks 'Run Doctor' in panel
- Alert debounce: same alert not sent more than once per 15 minutes

## 4. Kapasite profilleri

### Low

- audio-first
- video default off
- max camera users: 2
- max screen share: 1
- active speaker only

### Medium

- video opt-in
- max camera users: 4-6
- screen share 1
- active speaker + thumbnails

### High

- max camera users: 9
- grid optional
- screen share 1080p15
- TURN recommended

## 5. Telemetry snapshot

PostgreSQL’e yazılır:

```json
{
  "cpu": {},
  "memory": {},
  "disk": {},
  "network": {},
  "livekit": {},
  "redis": {},
  "postgres": {},
  "recommendation": {}
}
```

## Data Retention Policy

To prevent unbounded disk growth, the following retention policies apply:

| Data | Default Retention | Configurable | Cleanup Method |
|---|---|---|---|
| Messages | Unlimited | Yes (per-server) | Admin delete / user delete |
| Audit logs | 90 days | Yes | Automated cron, archive to file |
| Telemetry snapshots | 30 days | Yes | Automated cron, delete |
| Game sessions (ended) | 365 days | Yes | Automated cron, archive |
| Plugin events | 30 days | Yes | Automated cron, delete |
| Expired user sessions | 7 days after expiry | No | Automated cron, delete |
| Expired invites | 7 days after expiry | No | Automated cron, delete |
| Orphaned uploads | 30 days | No | Weekly cron, delete file |
| Docker logs | 7 days / 100 MB | Via Docker config | Docker log rotation |

### Cleanup Implementation

```sql
-- Daily cleanup cron (runs at 03:00 UTC)
DELETE FROM audit_logs WHERE created_at < now() - interval '90 days';
DELETE FROM telemetry_snapshots WHERE created_at < now() - interval '30 days';
DELETE FROM plugin_events WHERE created_at < now() - interval '30 days';
DELETE FROM user_sessions WHERE expires_at < now() - interval '7 days';
DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at < now() - interval '7 days';

-- Monthly archive
COPY (SELECT * FROM game_sessions WHERE ended_at < now() - interval '365 days')
TO '/data/backups/archived_game_sessions.csv';
DELETE FROM game_sessions WHERE ended_at < now() - interval '365 days';
```

### Disk Usage Monitoring

Doctor includes disk usage check:
- ⚠️ Warning at 80% disk usage
- 🔴 Critical at 90% disk usage
- 💀 Fatal at 95% disk usage
- Recommendation: "Clean old data or expand disk"

## 6. Admin panel

Sayfa:

```txt
Admin → System Health
```

Göstergeler:

- service status
- active users
- active rooms
- bitrate in/out
- Redis status
- DB status
- disk usage
- latest doctor result
- recommended settings

## 7. Otomatik ayar önerisi

Doctor önerileri uygulanabilir:

```txt
Apply recommended media profile
```

Şunları günceller:

- max video users
- max screen share
- default video off/on
- layout
- bitrate profile
- room user cap

## Backup Verification

### Automated Backup Testing

Backups are useless if they can't be restored. Monthly automated verification:

```bash
#!/bin/bash
# verify-backup.sh — runs monthly via cron
LATEST_BACKUP=$(ls -t /data/backups/*.tar.gz | head -1)

# 1. Extract to temp directory
mkdir -p /tmp/backup-verify
tar -xzf $LATEST_BACKUP -C /tmp/backup-verify

# 2. Start temporary PostgreSQL container
docker run -d --name pg-verify \
  -e POSTGRES_PASSWORD=verify \
  -v /tmp/backup-verify/postgres:/docker-entrypoint-initdb.d \
  postgres:17-alpine

# 3. Wait and check
sleep 10
docker exec pg-verify pg_isready
VERIFY_RESULT=$?

# 4. Cleanup
docker rm -f pg-verify
rm -rf /tmp/backup-verify

# 5. Report
if [ $VERIFY_RESULT -eq 0 ]; then
  echo "✅ Backup verification passed"
else
  echo "🔴 Backup verification FAILED"
  # Send alert via webhook
fi
```

### Recovery Targets

| Metric | Target | Notes |
|---|---|---|
| RPO (Recovery Point Objective) | 24 hours | Daily backups |
| RTO (Recovery Time Objective) | 1 hour | From fresh VPS |
| Backup frequency | Daily at 02:00 UTC | Configurable |
| Backup retention | 7 daily + 4 weekly | Configurable |

## 8. Kesin sayı iddiası yok

Doctor dili dikkatli olmalı:

Yanlış:

```txt
Bu sunucu kesin 100 kişi kaldırır.
```

Doğru:

```txt
Bu ayarlar altında güvenli öneri: 40 sesli kullanıcı.
Canlı kullanımda yeniden ölçüm önerilir.
```
