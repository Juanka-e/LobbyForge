# 17 — Windows Geliştirme Ortamı

## 1. Kullanıcı durumu

Geliştirici kendi bilgisayarında Windows kullanıyor. Bu sorun değildir ama doğru ortam kurulmalıdır.

## 2. Önerilen ortam

- Windows 11
- WSL2 Ubuntu
- Docker Desktop WSL2 backend
- VS Code
- VS Code Remote WSL
- Node.js WSL içinde
- pnpm WSL içinde
- repo WSL filesystem içinde

Repo konumu:

```txt
/home/erdal/projects/lobbyforge
```

Kaçınılacak konum:

```txt
C:\Users\Erdal\Desktop\lobbyforge
```

## 3. Neden WSL?

- Linux production’a daha yakın
- Docker volume performansı daha iyi
- path farkları azalır
- shell scriptler gerçek Linux’ta test edilir
- Nginx/PostgreSQL/Redis/LiveKit containerları daha doğal çalışır

## 4. Local dev servisleri

Docker Compose dev:

- PostgreSQL
- Redis
- LiveKit
- Mailpit optional
- MinIO optional
- coturn optional

Next.js lokal:

```bash
pnpm dev
```

## 5. Kurulum adımları

```bash
sudo apt update
sudo apt install -y git curl build-essential
curl -fsSL https://get.pnpm.io/install.sh | sh -
git clone https://github.com/lobbyforge/lobbyforge.git
cd lobbyforge
pnpm install
docker compose -f infra/docker-compose.dev.yml up -d
pnpm dev
```

## 6. Olası sorunlar

- CRLF/LF satır sonu
- Docker volume yavaşlığı
- Windows firewall
- UDP port sorunu
- mikrofon izinleri
- browser secure context
- Defender performans etkisi
- file watcher limitleri

## 7. Çözüm notları

`.gitattributes`:

```txt
* text=auto eol=lf
*.bat text eol=crlf
*.ps1 text eol=crlf
```

WSL file watcher:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 8. Test

Lokal test:

- iki farklı browser profile
- localhost app
- LiveKit local
- mic permission
- text chat
- plugin activity

Remote test:

- test VPS
- domain
- HTTPS
- UDP
- iki farklı network
