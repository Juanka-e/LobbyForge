# 04 — Tek VPS Deployment: Nginx + PostgreSQL + Redis + LiveKit

## 1. Hedef

Başlangıçta tüm sistem tek VPS üzerinde Docker Compose ile çalışır.

Örnek VPS:

- Ubuntu 22.04/24.04
- 4 vCPU
- 8 GB RAM
- 80+ GB SSD
- Public IPv4
- Domain önerilir
- 100 Mbps veya üstü network önerilir

## 2. Servisler

Docker Compose servisleri:

- `nginx`
- `web`
- `postgres`
- `redis`
- `livekit`
- `coturn` optional
- `doctor` optional
- `registry` optional

## 3. Domain planı

Önerilen:

```txt
app.example.com  → Next.js
rtc.example.com  → LiveKit signaling
turn.example.com → coturn optional
```

Tek domain path routing mümkün ama ilk sürüm için önerilmez.

## 4. Portlar

Açılacak portlar:

```txt
80/tcp    HTTP
443/tcp   HTTPS/WSS
7880/tcp  LiveKit internal/proxy
7881/tcp  LiveKit TCP fallback optional
50000-60000/udp LiveKit ICE UDP range
3478/udp  TURN optional
3478/tcp  TURN optional
5349/tcp  TURNS optional
```

Not:

- PostgreSQL dış dünyaya açılmaz.
- Redis dış dünyaya açılmaz.
- DB ve Redis sadece Docker internal network’te kalır.

## 5. Örnek docker-compose.yml

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./infra/nginx/conf.d:/etc/nginx/conf.d:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - web
      - livekit
    networks:
      - edge

  web:
    image: ghcr.io/lobbyforge/lobbyforge-web:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://lobbyforge:${POSTGRES_PASSWORD}@postgres:5432/lobbyforge
      REDIS_URL: redis://redis:6379
      LIVEKIT_URL: wss://rtc.example.com
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      AUTH_SECRET: ${AUTH_SECRET}
      APP_PUBLIC_URL: https://app.example.com
    depends_on:
      - postgres
      - redis
    networks:
      - edge
      - internal

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: lobbyforge
      POSTGRES_USER: lobbyforge
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - internal

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    networks:
      - internal

  livekit:
    image: livekit/livekit-server:latest
    restart: unless-stopped
    command: ["--config", "/etc/livekit.yaml"]
    volumes:
      - ./infra/livekit/livekit.yaml:/etc/livekit.yaml:ro
    ports:
      - "50000-60000:50000-60000/udp"
    networks:
      - edge
      - internal

networks:
  edge:
  internal:

volumes:
  postgres_data:
  redis_data:
```

## 6. Örnek Nginx app config

```nginx
server {
    listen 80;
    server_name app.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name app.example.com;

    ssl_certificate /etc/nginx/certs/app/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/app/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## 7. Örnek Nginx LiveKit config

```nginx
server {
    listen 80;
    server_name rtc.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name rtc.example.com;

    ssl_certificate /etc/nginx/certs/rtc/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/rtc/privkey.pem;

    location / {
        proxy_pass http://livekit:7880;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## 8. TLS

İlk sürümde iki yöntem olabilir:

1. Installer certbot kurar ve sertifikaları üretir.
2. Kullanıcı kendi sertifikalarını `/certs` altına koyar.

MVP için installer certbot ile otomasyon yapmalıdır.

## 9. Alan adı olmayan kurulum

WebRTC mikrofon/kamera için HTTPS gerekir. Bu nedenle IP-only kurulum sınırlı desteklenir.

Modlar:

- Domain ile önerilen kurulum
- IP ile experimental test
- LAN/local test
- İleride geçici `*.lobbyforge.net` subdomain servisi

Official public registry için domain + HTTPS zorunlu olmalıdır.

## 10. Production checklist

- [ ] Domain DNS VPS’e gidiyor
- [ ] 80/443 açık
- [ ] LiveKit UDP range açık
- [ ] PostgreSQL dışarı kapalı
- [ ] Redis dışarı kapalı
- [ ] HTTPS aktif
- [ ] WSS aktif
- [ ] LiveKit token endpoint çalışıyor
- [ ] 2 client aynı odaya girebiliyor
- [ ] Doctor uyarı vermiyor
- [ ] Backup cron aktif
