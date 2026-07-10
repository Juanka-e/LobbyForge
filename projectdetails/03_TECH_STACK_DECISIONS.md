# 03 — Teknik Stack Kararları

## 1. Kesin kararlar

- Reverse proxy: Nginx
- Database: PostgreSQL
- Cache/pubsub/presence: Redis
- Media/SFU: LiveKit
- UI/API: Next.js
- Desktop: Electron
- Deployment: Docker Compose
- Server OS: Ubuntu
- Çeviri: JSON language packs

## 2. Neden Nginx?

Caddy self-host kolaylığı açısından çok iyi olsa da bu projede karar Nginx olarak sabitlenmiştir.

Nginx seçme nedenleri:

- Sektörde çok yaygın
- Dokümantasyon ve örnek çok fazla
- WebSocket reverse proxy desteği olgun
- Rate limit, header, caching, request limit gibi ayarlarda esnek
- Mevcut VPS/production deneyimleriyle uyumlu
- Gelişmiş kullanıcılar için daha tanıdık
- Tek VPS ve ileride multi-service yapıya uygun

Dikkat edilmesi gerekenler:

- TLS otomasyonu için certbot veya acme companion gerekir.
- WebSocket upgrade headerları doğru yazılmalıdır.
- LiveKit signaling için proxy timeoutlar doğru ayarlanmalıdır.
- UDP medya trafiği Nginx HTTP reverse proxy’den geçmez; LiveKit portları ayrıca açılır.
- TURN/coturn kullanılacaksa portlar ayrıca planlanır.

## 3. Neden PostgreSQL?

PostgreSQL, LobbyForge için varsayılan DB olmalıdır.

Nedenler:

- JSONB ile plugin state ve ayarlar daha rahat tutulur.
- Transaction desteği güçlüdür.
- Full-text search olanakları güçlüdür.
- Migration ve ORM ekosistemi olgun.
- Açık kaynak self-host projelerde güvenilir seçimdir.
- Audit log, telemetry, registry metadata gibi karma veriler için uygundur.

MariaDB kötü değildir ama bu proje için varsayılan olmamalıdır. İleride istenirse community DB adapter olarak desteklenebilir.

## 4. Neden Redis?

Redis ana DB değildir. Ama realtime sistemlerde çok işe yarar.

Kullanım alanları:

- presence
- online user state
- pub/sub
- rate limit
- distributed lock
- queue
- temporary game state
- typing indicator
- short-lived session state

Redis olmadan da ilk prototip yapılabilir ama MVP self-host için Redis Compose’a dahil edilmelidir.

## 5. Neden LiveKit?

LiveKit seçme nedenleri:

- WebRTC SFU olarak hazır ürünleşmiş yapı sunar.
- Room/participant/track modeli bizim uygulama modelimize uyar.
- Client SDK’ları hazırdır.
- Data channel desteği plugin eventleri için uygundur.
- Webhooks backend state için faydalıdır.
- Self-host deployment mümkündür.
- İleride AI/agent/bot tarafında genişleme alanı sunar.

Alternatifler:

- mediasoup: çok güçlü ama daha low-level
- Janus: esnek ama daha fazla entegrasyon yükü
- Jitsi: meeting odaklı
- Pion: çok low-level, MVP için ağır

Karar:

```txt
MVP ve v1: LiveKit
İleri: MediaProvider abstraction
```

## 6. Neden Next.js?

- Web UI ve API aynı repo içinde hızlı gelişir.
- React ekosistemi plugin UI için uygundur.
- App Router ile modern yapı kurulabilir.
- SSR/CSR karışık kullanılabilir.
- Admin panel, registry UI ve main app aynı design system’i paylaşabilir.

### 6.1 Hedef web stack

2026 hedefi icin web app modern stable hatta tasinmalidir:

```txt
Next.js: 16.x
React: 19.2.x
React DOM: 19.2.x
Node.js: 22.x LTS veya daha yeni
```

Next.js 16 ile `middleware.ts` yerine network boundary icin `proxy.ts` tercih edilir. Mevcut `withApiSecurity` route wrapper'i tamamen atilmaz; route-level security headers, method allowlist ve rate-limit icin devam edebilir. Global redirect/auth boundary, tenant/domain routing veya registry handoff gibi request seviyesinde kararlar gerekiyorsa `proxy.ts` kullanilir.

Gecis ayri migration olarak yapilmalidir:

- `next`, `react`, `react-dom`, React type paketleri guncellenir
- async params/cookies/headers kullanimi kontrol edilir
- image/cache/revalidate breaking changes kontrol edilir
- Playwright + Vitest smoke suite calisir
- production Docker build test edilir

## 7. Neden Electron?

Electron ana ürün değildir; web uygulamasının desktop wrapper’ıdır.

Gerekçeler:

- global push-to-talk
- tray
- masaüstü bildirimleri
- cihaz kısayolları
- oyun oynarken kolay kullanım
- auto-update

Electron ilk günden değil, web app oturduktan sonra eklenmelidir.

## 8. ORM seçimi

Öneriler:

- Drizzle ORM: tip güvenliği, SQL’e yakınlık, migration kontrolü
- Prisma: hızlı geliştirme, yaygın kullanım
- Kysely: type-safe SQL query builder

Bu proje için öneri:

```txt
Drizzle veya Kysely
```

Plugin-heavy ve schema kontrolü gereken bir projede SQL’e yakın olmak avantajdır.

## 9. Package manager

Öneri:

```txt
pnpm workspace
```

Monorepo için hızlı ve temizdir.

## 10. Monorepo yapısı

```txt
apps/
  web/
  desktop/
  registry/

packages/
  core/
  ui/
  i18n/
  plugin-sdk/
  bot-sdk/
  db/
  config/

plugins/
  hushle/
  vampire-village/
  quiz/
  watch-party/

infra/
  docker/
  nginx/
  installer/
```
