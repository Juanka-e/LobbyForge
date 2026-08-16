# LobbyForge Docs (DESIGN ARCHIVE)

> **Status: archive.** These are the ORIGINAL planning/design documents.
> They describe flows and endpoints that may not exist (e.g.
> get.lobbyforge.org, --ip-only installer flags) and are NOT kept in
> sync with the implementation. For living documentation see the repo
> README, `docs/`, `infra/docker/README.md` and the inline code comments.

Bu klasör, **LobbyForge** projesinin baştan sona ürün ve teknik dokümantasyon paketidir (tasarım arşivi).

Karar seti:

- Ana konum: Açık kaynak, self-host edilebilir, sesli topluluk + oyun odaları platformu
- Ana istemci: Web/PWA
- Desktop: Tauri 2 wrapper (media-spike gated; Electron fallback)
- Reverse proxy: Nginx
- Database: PostgreSQL
- Cache / realtime yardımcı katman: Redis
- Media/SFU: LiveKit
- Kurulum hedefi: Tek VPS + Docker Compose + tek komut installer
- Pluginler: İlk aşamada official pluginler; ileride güvenli community plugin sistemi
- İlk oyun pluginleri: Hushle ve Vampir Köylü
- Public server sistemi: Self-host instance registry + signed heartbeat + domain verification
- Çeviri: JSON dil paketleri + PR + CI check

## Dosya listesi

- `00_MASTER.md` — tüm projenin tek dosyalık özeti
- `01_PRODUCT_VISION.md` — ürün vizyonu, hedef kullanıcı, positioning
- `02_ARCHITECTURE.md` — sistem mimarisi
- `03_TECH_STACK_DECISIONS.md` — Redis/PostgreSQL/Nginx/LiveKit kararları
- `04_DEPLOYMENT_SINGLE_VPS_NGINX.md` — tek VPS deployment
- `05_INSTALLER_ONE_COMMAND.md` — tek komut kurulum planı
- `06_DATABASE_POSTGRESQL_SCHEMA.md` — PostgreSQL şema taslağı
- `07_REDIS_STRATEGY.md` — Redis kullanım stratejisi
- `08_LIVEKIT_MEDIA.md` — LiveKit medya katmanı
- `09_AUTH_SECURITY_PRIVACY.md` — auth, güvenlik, gizlilik
- `10_PUBLIC_DIRECTORY_REGISTRY.md` — public self-hosted server directory
- `11_PLUGIN_SYSTEM.md` — plugin/activity sistemi
- `12_HUSHLE_PLUGIN.md` — Hushle oyun plugin tasarımı
- `13_VAMPIRE_VILLAGE_PLUGIN.md` — Vampir Köylü plugin tasarımı
- `14_BOTS_MUSIC_WATCH_PARTY.md` — botlar, müzik, watch party
- `15_I18N_JSON.md` — JSON tabanlı çeviri sistemi
- `16_ELECTRON_DESKTOP.md` — Tauri desktop client (historical filename retained)
- `17_WINDOWS_DEV_ENV.md` — Windows geliştirme ortamı
- `18_API_EVENT_FLOWS.md` — API ve event akışları
- `19_OBSERVABILITY_DOCTOR_CAPACITY.md` — Doctor, telemetry, kapasite önerileri
- `20_OPEN_SOURCE_COMMUNITY_MARKETING.md` — açık kaynak ve duyuru stratejisi
- `21_ROADMAP.md` — aşama aşama geliştirme planı
- `22_BACKLOG_IDEAS.md` — ileri fikir havuzu
- `23_CHECKLISTS.md` — checklistler
- `24_REALTIME_STRATEGY.md` - realtime strategy
- `25_TESTING_STRATEGY.md` - testing strategy
- `26_CLIENT_STATE_MANAGEMENT.md` - client state management
- `27_FILE_STORAGE.md` - file storage
- `28_CI_CD_PIPELINE.md` - CI/CD pipeline
- `29_API_DESIGN_STANDARDS.md` - API design standards
- `30_LOGGING_MONITORING.md` - logging and monitoring
- `31_PRODUCT_DECISIONS_AUTH_APPS_UPDATES.md` - auth policy, app/game UI, bot UI, settings, one-click update and refactor decisions
- `32_SECURITY_REVIEW_REFACTOR_PLAN.md` - security findings, catalog safety model and refactor order
