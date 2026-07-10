# 05 — Tek Komut Kurulum Planı

## 1. Hedef

Kullanıcı kendi VPS’ine SSH ile girip tek komutla LobbyForge kurabilmelidir.

Önerilen komut:

```bash
curl -fsSL https://get.lobbyforge.org | bash
```

Güvenli alternatif:

```bash
curl -fsSL https://get.lobbyforge.org -o install.sh
less install.sh
bash install.sh
```

## 2. Installer ne yapmalı?

`install.sh` şu işleri yapar:

1. İşletim sistemi kontrolü
2. Root/sudo kontrolü
3. CPU/RAM/disk kontrolü
4. Docker kontrolü
5. Docker Compose kontrolü
6. Eksik paketleri kurma
7. Domain bilgisi alma
8. Admin email alma
9. `.env` oluşturma
10. Güçlü secret üretme
11. Nginx config üretme
12. LiveKit config üretme
13. PostgreSQL/Redis/Web/LiveKit containerlarını başlatma
14. Certbot/TLS işlemi
15. Health check
16. Doctor check
17. Setup wizard linki verme

## 3. Kurulum modları

### 3.1 Standart domain kurulumu

```bash
bash install.sh
```

Sorular:

```txt
App domain: app.example.com
RTC domain: rtc.example.com
Admin email: admin@example.com
Enable public directory? yes/no
Enable video by default? yes/no
```

### 3.2 IP-only experimental

```bash
bash install.sh --ip-only
```

Uyarı:

- Voice/video garanti edilmez.
- Official registry’ye alınmaz.
- Sadece test/LAN/demo için önerilir.

### 3.3 Advanced

```bash
bash install.sh --advanced
```

Sorular:

- external PostgreSQL?
- external Redis?
- custom LiveKit?
- custom Nginx?
- TURN enabled?
- registry enabled?

## 4. Dosya yapısı

```txt
/opt/lobbyforge/
  docker-compose.yml
  .env
  infra/
    nginx/
    livekit/
    certbot/
  data/
    postgres/
    redis/
    uploads/
    backups/
  scripts/
    upgrade.sh
    doctor.sh
    backup.sh
    restore.sh
```

## 5. Secret üretimi

Üretilecek secretlar:

- `AUTH_SECRET`
- `POSTGRES_PASSWORD`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `REGISTRY_INSTANCE_PRIVATE_KEY`
- `BOT_TOKEN_SECRET`
- `ENCRYPTION_KEY_OPTIONAL`

Secretlar `.env` içinde tutulur. `.env` dosyası dışarı paylaşılmaz.

## 6. Upgrade

Komut:

```bash
/opt/lobbyforge/scripts/upgrade.sh
```

Yapacakları:

1. Maintenance mode optional
2. DB backup
3. yeni image pull
4. migration
5. container restart
6. health check
7. rollback önerisi

## 6.1 Admin panelden tek tikla update

Self-host admin Docker'i bastan kurmadan update alabilmelidir.

Admin UI:

```txt
Admin -> System -> Updates

Current version
Latest stable version
Release notes
Preflight doctor result
Backup status

[Check for updates]
[Update now]
[Schedule maintenance]
[Rollback last update]
```

Tek tikla update, arka planda `lfctl update apply` veya `/opt/lobbyforge/scripts/upgrade.sh` calistirir.

Guvenli update kurallari:

- update oncesi otomatik DB backup zorunlu
- migration dry-run veya plan ozeti gosterilir
- Docker image pull + compose recreate yapilir
- custom compose/nginx degisiklikleri varsa admin uyarilir
- health check basarisizsa rollback opsiyonu cikar
- major version update icin ekstra onay gerekir
- auto-update varsayilan kapali olmalidir

## 7. Backup

Komut:

```bash
/opt/lobbyforge/scripts/backup.sh
```

Backup içeriği:

- PostgreSQL dump
- uploads
- .env encrypted optional
- plugin settings
- registry config
- nginx configs
- livekit config

## 8. Restore

```bash
/opt/lobbyforge/scripts/restore.sh backup.tar.gz
```

## 9. Doctor

```bash
/opt/lobbyforge/scripts/doctor.sh
```

Kontroller:

- Docker running
- containers healthy
- app domain resolves
- rtc domain resolves
- HTTPS valid
- WSS valid
- LiveKit reachable
- UDP open
- PostgreSQL accessible
- Redis accessible
- disk free
- memory pressure
- CPU load

## 10. İleride lfctl

İleride shell script yerine CLI:

```bash
lfctl install
lfctl upgrade
lfctl doctor
lfctl backup create
lfctl backup restore
lfctl registry join
lfctl plugins enable hushle
lfctl plugins disable vampire-village
lfctl logs web
```
