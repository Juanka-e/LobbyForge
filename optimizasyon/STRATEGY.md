# LobbyForge — Proje Konumlandırma, Strateji ve İçerik Planı

> Projenin tüm codebase'i (22+ tablo, 14 workspace, 4 plugin, 49 design ekranı, 20+ docs) derinlemesine incelenerek hazırlanmıştır.

---

## 1. Projeyi Ne Olarak Konumlandırırsın?

### 🎯 Tek Cümlelik Kimlik

> **LobbyForge: Self-hostable, voice-first community platform with a built-in plugin SDK for live activities.**

### Uzun Tanım

LobbyForge, toplulukların kendi sunucularında barındırabildiği, **sesli iletişimi merkeze alan** ve **voice room'ların içinde oyun/aktivite çalıştırabilen** açık kaynak bir community platformudur. Discord'un "sunucu → kanal → ses odası" yapısını alır ama 3 kritik farkla yeniden tanımlar:

| # | Fark | Açıklama |
|---|------|----------|
| 1 | **Self-Hostable** | Verinin sahibi topluluk. Docker Compose ile 3 dakikada ayağa kalkar. |
| 2 | **Voice-First + Plugin SDK** | Ses odasının içinde Taboo, Quiz, Mafia, Watch Party gibi aktiviteler çalışır. Topluluk kendi plugin'ini yazabilir. |
| 3 | **Guest-Friendly** | Hesap zorunlu değil. Davet linki → tek tıkla sesli odaya katıl. Bariyer sıfır. |

### Rakip Haritası ve Konumlandırma

```
                    Voice-First
                        ▲
                        │
          TeamSpeak ●   │   ● LobbyForge ← BURASI
           Mumble ●     │     (voice + plugins + self-host)
                        │
   ◄────────────────────┼────────────────────►
   Proprietary          │          Self-Hosted / Open Source
                        │
         Discord ●      │      ● Revolt (text-first, plugin yok)
        Guilded ●       │      ● Element/Matrix (federated, karmaşık)
                        │      ● Rocket.Chat (enterprise, text-first)
                        │
                    Text-First
```

> **LobbyForge'un boş olan niche'i:** Voice-first + Plugin SDK + Self-hostable. Bu üçlüyü birlikte sunan başka bir açık kaynak proje yok.

### Marka Kimliği: "Calm Future"

Design system zaten bunu çözmüş — "Calm Future Design System v2.0":

- **Değil:** Neon, gamer-estetik, Discord klonu
- **Olan:** Sakin, premium, gelecek-odaklı, güvenilir altyapı hissi
- Palette: Derin uzay siyahı (`#070A0F`) + buz mavisi accent (`#8FB8FF`) + amber aktivite rengi (`#E7B86A`)
- Font: Geist — modern, temiz, okunabilir
- Glassmorphism kartları, subtle animasyonlar

---

## 2. 🩺 Health / Doctor Sistemi — Kapasite Analizi Detayları

### Mevcut Sistem (Zaten İnşa Edilmiş)

Doctor sistemi `packages/core/src/doctor.ts` dosyasında **platform-agnostic** olarak inşa edilmiş, 267 satır pure TypeScript. Sunucunun **ne kadar yükü kaldırabileceğini** otomatik analiz ediyor:

#### Kapasite Profili (Otomatik Hesaplanır)

| Tier | Ses/Oda | Kamera/Oda | Ekran Paylaşımı | Video Varsayılan | Layout |
|------|---------|------------|-----------------|------------------|--------|
| **LOW** (≤1 CPU veya <2GB RAM) | 10 kişi | 2 kamera | 1 ekran | Kapalı | Active speaker |
| **MEDIUM** (2-3 CPU, 2-7GB RAM) | 40 kişi | 5 kamera | 1 ekran | İsteğe bağlı | Speaker + thumbnails |
| **HIGH** (≥4 CPU, ≥8GB RAM, disk <%70) | 100 kişi | 9 kamera | 2 ekran | Açık | Grid |

#### Tier Belirleme Algoritması

```
1. CPU ve RAM'e göre ilk tier seçimi (LOW / MEDIUM / HIGH)
2. Disk basıncı kontrolü:
   - ≥%95 doluluk → Tier zorla LOW'a düşür
   - ≥%90 doluluk ve HIGH → MEDIUM'a düşür
3. Yük kontrolü:
   - CPU başına load >2 → Bir tier düşür
   - CPU başına load >4 → CRITICAL alarm
4. Sonuç: Tier + insan-okunabilir açıklama ("guidance")
```

#### Sağlık Kontrolleri (10 Check, 4 Kategori)

| Check ID | Kategori | Ne Zaman Alarm Verir |
|----------|----------|---------------------|
| `cpu_count` | system | Her zaman OK (bilgi amaçlı) |
| `memory_free` | system | <%10 boş → CRITICAL; <%20 → WARNING |
| `disk_usage` | system | ≥%95 → FATAL; ≥%90 → CRITICAL; ≥%80 → WARNING |
| `load_average` | system | CPU başına ≥2 → WARNING; ≥4 → CRITICAL |
| `https` | network | HTTPS erişilemez → CRITICAL |
| `udp_range` | network | UDP kapalı → WARNING (LiveKit için gerekli) |
| `postgres` | services | PostgreSQL erişilemez → CRITICAL |
| `redis` | services | Redis erişilemez → CRITICAL |
| `livekit_signaling` | services | LiveKit erişilemez → CRITICAL |
| `turn_configured` | media | TURN yok + UDP kapalı → WARNING |

#### Endpoint'ler

| Route | Erişim | Hız Limiti | Amaç |
|-------|--------|------------|------|
| `GET /api/health` | Public | 120/dakika | Basit sağlık durumu |
| `GET /api/doctor` | Admin (token gerekli) | 12/dakika | Detaylı rapor + kapasite |
| `GET /admin/health` | Admin (cookie) | — | Görsel dashboard |

### 🆕 Eksik ve Eklenmesi Gereken Health Özellikleri

Mevcut sistem sağlam ama aşağıdaki özellikler henüz eksik:

#### a) Bandwidth (Bant Genişliği) İzleme

**Durum:** Henüz yok. Eklenmeli.

```
Önerilen yeni check'ler:
┌─────────────────────────────────────────────────────────────┐
│ bandwidth_usage     │ network  │ Anlık bant genişliği       │
│                     │          │ ≥%80 → WARNING             │
│                     │          │ ≥%95 → CRITICAL            │
├─────────────────────────────────────────────────────────────┤
│ bandwidth_estimate  │ network  │ Tahmini: X ses odası +     │
│                     │          │ Y kamera = Z Mbps gerekli  │
│                     │          │ Mevcut: W Mbps kullanılabilir│
├─────────────────────────────────────────────────────────────┤
│ livekit_room_count  │ services │ Aktif oda sayısı /         │
│                     │          │ tahmini kapasite            │
└─────────────────────────────────────────────────────────────┘
```

**Bandwidth hesaplama formülü (tahmini):**
- Ses: ~50 Kbps/kullanıcı (Opus codec)
- Kamera (360p): ~500 Kbps/kullanıcı
- Kamera (720p): ~1.5 Mbps/kullanıcı
- Ekran paylaşımı: ~2-5 Mbps

Bir oda 10 sesli + 2 kameralı = ~10×50Kbps + 2×500Kbps = ~1.5 Mbps upload
Bu tahmini kapasite profilinin `detail` alanına eklenebilir.

#### b) Gerçek Zamanlı Uyarı Sistemi

**Durum:** Spec'te tanımlı ama henüz implemente edilmemiş.

```
Önerilen uyarı kanalları:
1. Admin dashboard banner (anlık)
2. WebSocket push notification (gerçek zamanlı)
3. Webhook URL'e POST (Slack, Telegram entegrasyonu)
4. Periyodik e-posta özeti (günlük/haftalık)
```

#### c) LiveKit Room Metrikleri

**Durum:** LiveKit SDK'da `RoomServiceClient` var, metrikleri çekebilir.

```
Eklenebilecek metrikler:
- Aktif oda sayısı
- Toplam katılımcı sayısı
- Oda başına ortalama süre
- Peak concurrent users (tarihsel)
- Bandwidth per room (LiveKit API'den)
```

#### d) Tarihsel Veri ve Trend

**Durum:** `telemetry_snapshots` tablosu schema'da zaten var ama boş.

```
Önerilen: Doctor raporunu her 15 dakikada telemetry_snapshots'a kaydet.
Admin panelde son 24 saat / 7 gün / 30 gün grafik göster.
Trend analizi: "Son 7 günde RAM kullanımı %15 arttı" uyarısı.
```

---

## 3. 🔒 Gizlilik ve SEO — Maksimum Seviye

### Mevcut Gizlilik Altyapısı (Zaten İnşa Edilmiş)

Schema'da gizlilik altyapısı zaten sağlam:

#### Instance Seviyesi (Tüm Sunucu İçin)

`instance_settings` tablosu (schema.ts:231):

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `seoIndexingEnabled` | `false` ✅ | Google/Bing indekslemesi kapalı |
| `seoTitle` | `null` | SEO başlığı (opsiyonel) |
| `seoDescription` | `null` | SEO açıklaması (opsiyonel) |
| `isPublicDirectoryEnabled` | `false` ✅ | Instance registry'de listeleme kapalı |
| `registrationMode` | `'open'` ⚠️ | Kayıt modu (değiştirilmeli) |
| `guestAccessEnabled` | `true` | Misafir erişimi |
| `maintenanceMode` | `false` | Bakım modu |

#### Server (Sunucu) Seviyesi

`server_access_policies` tablosu (schema.ts:47):

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `joinPolicy` | `'invite_only'` ✅ | Sadece davet ile katılım |
| `externalIdentity` | `'off'` ✅ | Dış kimlik sağlayıcı kapalı |
| `localAccount` | `'allow_local_email_password'` | Yerel hesap oluşturma |
| `accountLinking` | `'allow_link'` | Hesap bağlama |
| `requireApprovalForFirstJoin` | `false` | İlk katılımda onay gerekli mi |

#### Kullanıcı Seviyesi

`user_settings.privacy` (JSONB, schema.ts:391) — kullanıcı başına gizlilik ayarları.

#### Web App Güvenlik Başlıkları

Zaten uygulanmış:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- SameSite=Lax cookie'ler
- HMAC-SHA256 imzalı session'lar

### 🆕 Eklenmesi / Güçlendirilmesi Gereken Gizlilik Özellikleri

#### a) SEO Gizliliği (Varsayılan: Tamamen Kapalı)

```
Mevcut: seoIndexingEnabled = false (varsayılan) ✅
Eksik:  robots.ts dosyası var ama instance_settings'den okumuyor olabilir

Önerilen akış:
1. seoIndexingEnabled = false → robots.txt: "Disallow: /"
2. seoIndexingEnabled = true  → robots.txt: Sadece public sayfaları izin ver
3. Her sayfaya <meta name="robots" content="noindex, nofollow"> ekle (seo kapalıyken)
4. Admin panelde toggle: "Arama motorlarında görünsün mü?"
```

#### b) Kayıt Modu (registrationMode)

**Mevcut:** `registrationMode = 'open'` — bu değişmeli.

```
Önerilen modlar:
┌──────────────────┬───────────────────────────────────────────┐
│ 'closed'         │ Hiçbir yeni kayıt yok. Admin davet eder. │
│ 'invite_only'    │ ← ÖNERİLEN VARSAYILAN                    │
│                  │ Sadece davet linki olan kayıt olabilir.   │
│ 'approval'       │ Kayıt olunur, admin onaylar.             │
│ 'open'           │ Herkes kayıt olabilir. (Mevcut varsayılan)│
└──────────────────┴───────────────────────────────────────────┘

Varsayılanı 'open' → 'invite_only' olarak değiştirilmeli.
Self-host = kapalı topluluk. Açık kayıt varsayılan olmamalı.
```

#### c) Maksimum Gizlilik Profili

```
"Paranoid Mode" — Tek toggle ile her şeyi kapatır:

✅ SEO indexing kapalı
✅ Public directory kapalı
✅ Kayıt: invite_only
✅ Guest erişimi: kapalı
✅ Dış kimlik: kapalı
✅ Hesap bağlama: kapalı
✅ İlk katılımda onay gerekli
✅ Telemetry: kapalı
✅ robots.txt: Disallow all
✅ X-Robots-Tag: noindex, nofollow
✅ Referrer-Policy: no-referrer
✅ Permissions-Policy: her şey kapalı
```

#### d) Presence Gizliliği

Mevcut: `user_settings.privacy` JSONB'de zaten var. Kullanıcı çevrimiçi durumunu gizleyebilir, aktivite görünürlüğünü kontrol edebilir. Presence sistemi bu ayarları zaten filtreliyor (`docs/PRESENCE.md`'de belgelenmiş).

---

## 4. 🎮 Plugin Dağıtım Stratejisi — Kurulu mu Gelmeli, Eklenebilir mi Olmalı?

### Analiz

| Yaklaşım | Artı | Eksi |
|-----------|------|------|
| **Hepsi kurulu gelsin** | Sıfır setup, hemen oyna | Şişkin kurulum, kullanmayan için gereksiz, güncelleme zorluğu |
| **Hepsi ayrı yüklensin** | Temiz, modüler | İlk deneyim boş, "ne yapacağım?" sorusu, onboarding zor |
| **Hybrid: core bundled + hub'dan ekle** | ✅ En iyisi | Biraz daha karmaşık mimari |

### 🎯 Önerilen Model: "Batteries Included, But Removable"

```
Kurulumla Gelen (Pre-installed, devre dışı bırakılabilir):
├── 🎭 Hushle (Tabu) — flagship, tam oynanabilir
├── ❓ Quiz — basit, evrensel
└── 🎬 Watch Party — ses odası + video, çok kullanışlı

Hub'dan Eklenen (1-click install):
├── 🐺 Vampire Village (Kurt Köyü / Mafia)
├── 🎵 Music Bot
├── 🎨 Drawing Game
├── 🃏 Cards Against Humanity
└── ... community plugins

Server Admin Kontrolü:
├── Admin Panel → "Apps" sekmesi
├── Pre-installed olanları devre dışı bırakabilir
├── Hub'dan yeni ekleyebilir
└── Per-server: hangi sunucuda hangi plugin aktif
```

**Gerekçe:**
1. İlk açılışta boş bir platform kötü deneyim → en az 2-3 oyun kurulu gelmeli
2. Ama "şişkin" hissetmemeli → devre dışı bırakılabilir olmalı
3. Hub'dan ekleme mekanizması zaten trust level sistemiyle uyumlu
4. `plugins_enabled` tablosu per-server enable/disable zaten destekliyor

### Teknik İmplementasyon

Mevcut plugin registry (`apps/web/lib/plugin-registry.ts`) statik — compiled-in. Geçiş planı:

```
Faz 1 (Şimdi): Pre-installed plugins olarak gönder
  └── Hushle, Quiz, Watch Party monorepo'da kalır
  └── Server admin "Apps" sekmesinden enable/disable yapar
  └── plugins_enabled tablosu zaten var

Faz 2 (Hub MVP): Manifest-based remote install
  └── Hub'da plugin manifest URL'leri listelenir
  └── Admin "Install" → manifest URL alınır → plugin_sdk uyumluluğu kontrol
  └── Remote plugin bundle indirilir → plugins/ dizinine extract
  └── Trust level badge gösterilir (official / verified / unverified)

Faz 3 (Sandbox): Güvenli dynamic loading
  └── Plugin'ler izole worker/sandbox'ta çalışır
  └── Capability-based permission (manifest'teki permissions)
  └── Otomatik güvenlik review pipeline
```

---

## 5. 🎭 Rol Özelleştirmesi — Her Plugin/Bot/Tool İçin

### Mevcut Sistem

16 `CorePermission` tanımlı ve çalışıyor:

```
ADMINISTRATOR, MANAGE_SERVER, MANAGE_CHANNELS, MANAGE_ROLES,
KICK_MEMBERS, BAN_MEMBERS, CREATE_INVITE,
SEND_MESSAGES, MANAGE_MESSAGES, ADD_REACTIONS,
CONNECT_VOICE, SPEAK, MUTE_MEMBERS, DEAFEN_MEMBERS,
VIEW_AUDIT_LOG, START_ACTIVITY
```

Roller JSONB `permissions[]` array'i olarak saklanıyor. Multi-role (birden fazla rol) per member zaten destekleniyor (`membership_roles` join table). `hasPermission()` tüm rollerin union'ını alıyor.

### 🆕 Önerilen: Plugin-Scoped Permissions

Her plugin kendi permission'larını tanımlayabilmeli. Mevcut `PluginPermission` (11 tane) SDK'da var ama rol sistemine bağlı değil.

```
Önerilen mimari:

CorePermission (platform seviyesi, değiştirilemez):
├── ADMINISTRATOR
├── MANAGE_SERVER
├── CONNECT_VOICE
├── SEND_MESSAGES
└── ... (mevcut 16 permission)

PluginPermission (plugin seviyesi, plugin manifest'ten gelir):
├── hushle:manage_game
├── hushle:set_teams
├── quiz:create_questions
├── quiz:manage_session
├── watch_party:set_video
└── ... (her plugin kendi permission'larını tanımlar)

BotPermission (bot seviyesi, bot manifest'ten gelir):
├── music_bot:manage_queue
├── music_bot:skip_track
├── mod_bot:auto_moderate
└── ... (her bot kendi permission'larını tanımlar)
```

### Admin'in Rolü Özelleştirmesi

```
Admin Panel → Roles → "Edit Role" ekranı:

Genel Yetkiler:
  [x] Mesaj gönder
  [x] Ses odasına katıl
  [ ] Kanal yönet
  [ ] Üye at
  ...

Plugin Yetkileri:               ← YENİ
  Hushle:
    [x] Oyun başlat
    [x] Takım ayarla
    [ ] Oyunu yönet (host)
  Quiz:
    [x] Soru oluştur
    [ ] Oturumu yönet
  Watch Party:
    [x] Video seç
    [ ] Sync kontrol

Bot Yetkileri:                  ← YENİ
  Music Bot:
    [x] Parça ekle
    [ ] Sırayı yönet
    [ ] Parça atla
```

### Rol Template'leri

Server admin'leri hazır rol şablonları kullanabilmeli:

```
Varsayılan Şablonlar:
├── 🎮 "Gamer" → voice + activity + tüm oyun yetkileri
├── 📝 "Moderator" → manage_messages + kick + mute
├── 👁️ "Viewer" → sadece okuma + dinleme, yazma/konuşma yok
├── 🎭 "Game Master" → tüm plugin host yetkileri
└── 🛠️ "Admin" → her şey

Özelleştirme: Şablondan başla, istediğini değiştir.
```

---

## 6. 🌍 Evrensel i18n Sistemi — Plugin, Bot, Tool Hepsine Ortak

### Mevcut Durum

Üç ayrı i18n sistemi var — hepsi aynı pattern'i kullanıyor ama birbirinden bağımsız:

| Sistem | Konum | Kapsamı |
|--------|-------|---------|
| `@lobbyforge/i18n` | `packages/i18n/` | Platform UI çevirileri |
| Plugin SDK Locale | `packages/plugin-sdk/src/locale.ts` | Plugin çevirileri |
| Bot SDK Locale | `packages/bot-sdk/src/locale.ts` | Bot çevirileri |

Her üçü de aynı pattern: `registerLocale(id, locale, loader)` + `tFor(id, locale, key, params?)` + lazy caching.

### 🆕 Önerilen: Birleşik i18n Katmanı (`@lobbyforge/i18n-core`)

```
Mevcut (kopya kod, 3 ayrı registry):

  plugin-sdk/locale.ts  ──→ Map<pluginId, Map<locale, table>>
  bot-sdk/locale.ts     ──→ Map<botId, Map<locale, table>>
  packages/i18n/        ──→ Ayrı translator + validator

Önerilen (tek shared core, namespace'li):

  @lobbyforge/i18n-core  ──→ Map<namespace, Map<locale, table>>
    ├── namespace: "platform"     → Platform UI strings
    ├── namespace: "plugin:hushle" → Hushle strings
    ├── namespace: "plugin:quiz"   → Quiz strings
    ├── namespace: "bot:music"     → Music bot strings
    └── namespace: "tool:moderation" → Moderation tool strings
```

### Topluluk Çeviri Akışı

Tüm çevirilerin kolayca yapılabilmesi için:

```
1. JSON-based çeviri dosyaları (mevcut):
   locales/
   ├── en.json  ← kaynak dil
   ├── tr.json  ← Türkçe
   ├── de.json  ← Almanca
   └── fr.json  ← Fransızca

2. Çeviri katkısı:
   Seçenek A: GitHub PR → en.json'a bakarak tr.json'u düzenle
   Seçenek B: Web tabanlı çeviri arayüzü (Weblate/Crowdin entegrasyonu)
   Seçenek C: Admin panelde inline çeviri düzenleme

3. Çeviri doğrulama (zaten var):
   pnpm i18n:check → eksik key, fazla key, placeholder uyumsuzluğu tespit
```

### Plugin/Bot Geliştiricisi İçin i18n

```typescript
// Plugin'e yeni dil eklemek — TEK SATIR:
import en from './locales/en.json';
import tr from './locales/tr.json';
import de from './locales/de.json';  // ← Topluluk ekledi

loadPluginLocale('hushle', { en, tr, de });

// Plugin'in renderClient'ında kullanım:
const label = tFor('hushle', userLocale, 'game.start_button');
// → "Start Game" (en) / "Oyunu Başlat" (tr) / "Spiel starten" (de)
```

### Otomatik Locale Discovery

Plugin manifest'te desteklenen diller zaten var (`locales[]`). Hub bu bilgiyi gösterebilir:

```
Plugin Hub'da:
┌─────────────────────────────────────────┐
│ 🎭 Hushle (Tabu)                       │
│ ⭐ Official  │  v0.3.0  │  🌍 EN TR DE │
│                                         │
│ Taboo-style word guessing game for      │
│ voice rooms.                            │
│                                         │
│ [Install]  [Preview]                    │
└─────────────────────────────────────────┘
```

---

## 7. Plugin / Bot / Tools Hub Stratejisi

### Mevcut Durum

| Bileşen | Durum | Detay |
|---------|-------|-------|
| **Plugin SDK** | ✅ Sağlam | `GamePlugin<TState, TAction, TProps>` — pure reducer, 9 sub-context, action policies, state migration, test harness, locale |
| **Bot SDK** | 🟡 Tanımlı | `BotManifest`, `BotClient`, 9 permission — ama runtime yok |
| **Plugin Registry** | 🟡 Statik | `apps/web/lib/plugin-registry.ts` — compiled-in, redeploy gerekli |
| **Instance Registry** | 🟡 Scaffold | `apps/registry` — sadece type + helper, HTTP server yok |
| **Trust Levels** | ✅ Tanımlı | `official`, `verified-community`, `unverified` — manifest'te var |

### Önerilen Hub Mimarisi

```
                ┌──────────────────────────────────────┐
                │     Official Hub (hub.lobbyforge.dev) │
                │                                      │
                │  ┌──────────┐  ┌───────────────────┐ │
                │  │ Plugins  │  │ Bots              │ │
                │  │ Catalog  │  │ Catalog            │ │
                │  └────┬─────┘  └────────┬──────────┘ │
                │       │                 │            │
                │  ┌────▼─────────────────▼──────────┐ │
                │  │ Review & Trust Pipeline          │ │
                │  │ (official / verified / unverified)│ │
                │  └────┬────────────────────────────┘ │
                │       │                              │
                │  ┌────▼──────────────┐               │
                │  │ Instance Registry │               │
                │  └───────────────────┘               │
                └──────────────────────────────────────┘
                           │
                           │ 1-click install
                           │ (manifest URL)
                           ▼
                ┌──────────────────────────────────────┐
                │     Self-Host Instance               │
                │                                      │
                │  Admin Panel → "Apps" sekmesi         │
                │  ├── Pre-installed plugins            │
                │  ├── Hub'dan yüklenen plugins         │
                │  └── Kendisi yazdığı plugins (DIY)    │
                │                                      │
                │  Per-server: enable / disable         │
                └──────────────────────────────────────┘
```

### Üç Katmanlı Ekosistem

| Katman | Kim İçin | Nasıl |
|--------|----------|-------|
| **🏢 Official Hub** | Son kullanıcı / Server admin | Hub'da browse → "Install" → instance otomatik çeker. Manifest URL + signature verification zaten var. |
| **🧑‍💻 Community Marketplace** | Plugin geliştiriciler | `npm publish` + Hub'a submit → review → `verified-community` badge. Template repo + docs + test harness ile onboard. |
| **🔧 Self-Host DIY** | Teknik kullanıcılar | `plugins/` dizinine yeni klasör → SDK import → redeploy. Veya gelecekte: dynamic plugin loading (sandbox + WASM?) |

> Trust level sistemi zaten manifest'te var (`official` / `verified-community` / `unverified`). Hub sadece bunu UI'a taşır.

### Bot Ekosistemi (İkinci Faz)

Bot SDK tanımlı ama runtime yok. Önerilen yol:
1. Bot runtime'ı ws-gateway'e bağla (WebSocket bağlantısı)
2. Bot'lar sunucu dışından HTTP/WS ile bağlanabilsin
3. Hub'da "Bots" kategorisi — müzik botu, moderasyon botu, vb.
4. `bot-sdk` npm'de publish → topluluk bot yazabilsin

---

## 8. DM (Direct Message) Özelliği: Eklemeli mi?

### Analiz Tablosu

| Faktör | Tek Server (DM Yok) | DM Ekle | Opsiyonel/Plugin |
|--------|---------------------|---------|------------------|
| **Scope** | ✅ Küçük, odaklı | ❌ Büyük scope artışı | ✅ Modüler |
| **Moderasyon** | ✅ Server admin yönetir | ❌ DM moderasyonu çok zor | ✅ Admin açar/kapar |
| **Yasal** | ✅ Basit | ❌ GDPR, COPPA, abuse reporting | ✅ İsteğe bağlı |
| **Self-Host Uyumu** | ✅ Tek instance = tek topluluk | 🟡 Cross-instance DM = federation | ✅ Instance-scoped DM |
| **Kullanıcı Beklentisi** | 🟡 "DM nerede?" sorusu gelir | ✅ Beklenen feature | ✅ "İstersen ekle" |
| **Geliştirici Yükü** | ✅ Yok | ❌ Yeni tablo, notification, E2EE | 🟡 Orta |

### 🎯 Önerim: Opsiyonel — Core'da Değil, Feature Flag Olarak

```
İlk versiyon → DM yok, tek server odaklı
v1.x → "Direct Messages" feature flag (admin panelde toggle)
v2.x → İsteyen plugin olarak genişletir (encrypted DM, cross-instance, vb.)
```

**Gerekçe:**
1. LobbyForge'un kimliği "community platform", "messaging app" değil
2. Self-host = veri sahipliği. DM'de veri sahipliği daha da kritik (E2EE gerekir)
3. MVP'de DM olmaması r/selfhosted'da sorun olmaz — Mumble, TeamSpeak'te de yok
4. "DM opsiyonel" approach Reddit'te tartışma yaratır = engagement

> Reddit post'unda bunu açıkça sor: *"Should DM be a core feature or opt-in? We're leaning toward opt-in. What do you think?"*

---

## 9. Reddit İçerik Stratejisi

### Hangi Subreddit'lere, Ne Zaman?

| Faz | Subreddit | Dil | İçerik | Timing |
|-----|-----------|-----|--------|--------|
| **Faz 1: Tanıtım** | r/selfhosted | EN | "I'm building an open-source, voice-first community platform with a plugin SDK" | İlk post |
| **Faz 1** | r/opensource | EN | Aynı, open-source angle vurgusu | İlk hafta |
| **Faz 1** | r/Turkey veya r/Turkiye | TR | "Açık kaynak Discord alternatifi geliştiriyorum" | İlk hafta |
| **Faz 2: Teknik** | r/webdev | EN | "How I built a plugin SDK with pure reducers for real-time voice room games" | 2. hafta |
| **Faz 2** | r/node | EN | "Building a self-hostable platform: LiveKit + Redis + Next.js architecture" | 2. hafta |
| **Faz 3: Oyun** | r/gamedev | EN | "We built a SDK that lets you create party games for voice rooms" | 3. hafta |
| **Faz 4: Güncelleme** | r/selfhosted | EN | Dev log #2 — progress, screenshots, demo | Aylık |

### Subreddit Özel Notlar

- **r/selfhosted** → En önemli hedef kitle. Docker Compose, self-host, data ownership vurgusu. "Başka bir Discord klonu" görmek istemiyorlar — farkını ilk paragrafta söyle.
- **r/opensource** → Lisans, contribution guide, kod kalitesi vurgula.
- **r/webdev** → Mimari kararlar, tech stack, monorepo yapısı, plugin SDK design.
- **r/Turkey / r/Turkiye** → "Türk geliştirici olarak dünyaya açık kaynak proje" açısı güçlü.

---

## 10. Reddit Post'ları — Hazır Taslaklar

### 📝 Post #1 — r/selfhosted (İngilizce, Tanıtım)

---

**Title:** `I'm building LobbyForge — a self-hostable, voice-first community platform where you can play games inside voice rooms [open source]`

---

Hey r/selfhosted,

I've been working on **LobbyForge** for the past few weeks and wanted to share it early to get feedback from people who actually care about self-hosting.

**What is it?**

LobbyForge is a self-hostable community platform — think Discord's server/channel structure, but:

- 🎙️ **Voice-first**: Voice rooms are the center, not an afterthought
- 🎮 **Built-in Plugin SDK**: Play Taboo, Quiz, Mafia, Watch Party *inside* voice rooms. Or build your own game with our SDK
- 👤 **Guest-friendly**: Share a link → someone joins the voice room. No account required
- 🐳 **Docker Compose**: `docker compose up` → PostgreSQL + Redis + LiveKit. Done
- 🔒 **You own everything**: Your server, your data, your rules. SEO indexing off by default, invite-only registration, no telemetry

**Privacy by default:**

This is something I care deeply about. Out of the box:
- Search engines are blocked (`seoIndexingEnabled: false`)
- Registration is invite-only
- No third-party tracking or analytics
- Presence visibility is user-controlled
- All auth is local (HMAC-signed cookies, no external OAuth required)
- Instance never phones home

**Server health monitoring:**

The built-in Doctor system automatically profiles your hardware and tells you:
- How many voice users per room your server can handle (10 / 40 / 100)
- Camera and screen share capacity per room
- CPU, RAM, disk, network health with 4-level alerts (info → warning → critical → fatal)
- Service reachability (PostgreSQL, Redis, LiveKit, HTTPS, UDP)
- All accessible via admin dashboard + API endpoint

**Tech stack:**

- Next.js 15 (App Router) + TypeScript
- LiveKit for WebRTC voice (not a toy — it's what Twitch uses)
- PostgreSQL + Drizzle ORM (22+ tables)
- Redis for presence + pub/sub
- WebSocket gateway for real-time
- pnpm monorepo (14 workspaces)

**Plugin system:**

This is what I'm most excited about. Plugins are pure state-machine reducers:

```typescript
const myPlugin: GamePlugin<MyState, MyAction> = {
  manifest: { id: 'my-game', name: 'My Game', type: 'game', ... },
  createInitialState: (ctx) => ({ phase: 'lobby', scores: {} }),
  handleAction: (ctx, state, action) => {
    // Pure function: state in → state out. No side effects.
  },
  renderClient: (props) => <MyGameUI {...props} />
};
```

The SDK gives you 9 sub-contexts (players, timer, scores, voice, pubsub, cache, etc.), declarative action authorization, state versioning with auto-migration, and a test harness. Games ship pre-installed but are disable-able. Plugin hub (one-click install from marketplace) is planned.

**Current status:**

- ✅ Monorepo fully wired (build, lint, typecheck, test all pass)
- ✅ Auth (guest sessions + local owner login)
- ✅ Servers, channels (text/voice/activity/stage), roles (16 permissions), invites
- ✅ LiveKit voice rooms with mute/deafen/server-mute
- ✅ Redis presence with privacy settings
- ✅ WebSocket gateway with Redis pub/sub
- ✅ Plugin SDK + Hushle (Taboo) fully playable
- ✅ Doctor system with capacity profiling (voice/camera/screen share per room)
- ✅ Self-host update system with Ed25519 signed manifests + safety gates
- ✅ i18n (English + Turkish)
- 🔨 Desktop app (Electron) — scaffold ready
- 🔨 Plugin hub / marketplace — architecture planned
- 🔨 Bandwidth monitoring + trend analytics
- 🔨 3 more plugins (Quiz, Werewolf, Watch Party) — stubs ready

**What I'd love feedback on:**

1. **DM (Direct Messages)**: Should it be a core feature, or opt-in per instance? I'm leaning toward opt-in because of moderation complexity and the fact that this is a *community* platform, not a *messaging* app. Thoughts?
2. **Plugin distribution**: Games come pre-installed but removable. A marketplace for one-click install is planned. Should community plugins be sandboxed (WASM) or trust-level gated?
3. **Privacy defaults**: Right now, everything is locked down by default (no SEO, invite-only, no telemetry). Too paranoid, or just right for self-hosted?
4. **Would you actually use this?** Be honest. What would make you switch from Discord for your community?

Will share the repo soon. Just want to make sure the README and docs are solid first.

**[Screenshots / Demo GIF would go here]**

---

### 📝 Post #2 — r/Turkey veya r/Turkiye (Türkçe, Geliştirici Günlüğü)

---

**Başlık:** `Açık kaynak, self-host Discord alternatifi geliştiriyorum — ses odalarında Tabu, Quiz, Kurt Köyü oynanabiliyor [Geliştirici Günlüğü #1]`

---

Selamlar,

Birkaç haftadır **LobbyForge** adında bir proje geliştiriyorum ve süreci Türkçe paylaşmak istedim.

**Ne bu?**

Kendi sunucunuzda barındırabileceğiniz bir topluluk platformu. Discord'un sunucu/kanal yapısını alıyor ama 3 önemli farkı var:

🎙️ **Ses odaları merkeze alındı** — platform "önce ses" felsefesiyle tasarlandı

🎮 **Ses odalarının içinde oyun/aktivite çalışıyor** — Tabu (Hushle), Quiz, Kurt Köyü (Mafia), Watch Party. Hepsi yerleşik plugin olarak geliyor. İstersen kendi oyununu da yazabilirsin (Plugin SDK var)

👤 **Hesap açmak zorunlu değil** — davet linki paylaş, karşı taraf tek tıkla ses odasına katılsın

🐳 **Docker Compose ile 3 dakikada kurulum** — PostgreSQL + Redis + LiveKit, hepsi hazır

🔒 **Gizlilik ilk günden** — SEO kapalı, kayıt sadece davetle, telemetri yok, verinin sahibi sensin

**Sunucu sağlık izleme:**

Yerleşik "Doctor" sistemi sunucunun kapasitesini otomatik analiz ediyor:
- Ses odasına kaç kişi alınabilir (10 / 40 / 100 — donanıma göre)
- Kamera ve ekran paylaşımı kapasitesi
- CPU, RAM, disk, ağ durumu — 4 seviye uyarı sistemi
- Servis erişilebilirliği (PostgreSQL, Redis, LiveKit kontrol)

**Teknik detaylar (meraklıları için):**

- TypeScript monorepo (pnpm, 14 workspace)
- Next.js 15, LiveKit (WebRTC), PostgreSQL, Redis
- 22+ tablo, 16 yetki, rol sistemi, davet sistemi
- WebSocket gateway, Redis pub/sub ile gerçek zamanlı iletişim
- Ed25519 imzalı güncelleme sistemi (self-host güvenliği için)
- Türkçe + İngilizce dil desteği (i18n)

**Plugin sistemi nasıl çalışıyor?**

Oyunlar "pure reducer" pattern'iyle yazılıyor. State giriyor, action uygulanıyor, yeni state çıkıyor. Side effect yok — host her şeyi yönetiyor. Test harness ile oyununu izole test edebiliyorsun.

Pluginler hazır kurulu geliyor (Tabu, Quiz, Watch Party) ama devre dışı bırakılabilir. İleride bir "Plugin Hub" olacak — tek tıkla yeni oyunlar/botlar yüklenebilecek. İstersen kendi pluginini de yazabilirsin.

**Roller ve yetkiler:**

Her plugin kendi yetki setini tanımlayabiliyor. Server admin rolleri özelleştirebilir — "bu rol Tabu başlatabilir ama Quiz başlatamaz" gibi ince ayar yapılabilir. Plugin/bot/tool ayırt etmeksizin her şey aynı yetki sistemiyle çalışıyor.

**Çeviri sistemi:**

Platform, pluginler, botlar — hepsi aynı i18n altyapısını kullanıyor. Yeni dil eklemek tek satır:
```
loadPluginLocale('hushle', { en, tr, de });
```
Topluluk çevirisi yapabilir, PR göndermesi yeterli.

**Mevcut durum:**

- ✅ Altyapı tamam (build, test, lint, typecheck geçiyor)
- ✅ Auth, sunucular, kanallar, roller, davetler
- ✅ LiveKit ses odaları (mute/deafen/server-mute)
- ✅ Hushle (Tabu) tam oynanabilir (Türkçe + İngilizce kartlar)
- ✅ Doctor sistemi — kapasite analizi ve sağlık izleme
- 🔨 Desktop app (Electron), Plugin hub, bant genişliği izleme, 3 yeni oyun planlı

**Sizden feedback istediğim konular:**

1. **DM (Özel mesaj)** olmalı mı? Ben "opsiyonel" diyorum — platform bir topluluk aracı, mesajlaşma uygulaması değil. Ne dersiniz?
2. **Pluginler kurulu mu gelmeli yoksa mağazadan mı yüklenmeli?** Ben hybrid diyorum: temel oyunlar kurulu, geri kalanı hub'dan.
3. **Gizlilik varsayılanları:** SEO kapalı, kayıt sadece davetle, telemetri yok. Çok mu paranoyak, yoksa self-host için doğru mu?
4. **Böyle bir şeyi kullanır mıydınız?** Discord'dan ne eksik ki geçeyim dersiniz?

Projeyi ilerleyen haftalarda açık kaynak olarak paylaşacağım. Süreci burada günlük olarak yazacağım.

> Bu bir reklam değil — henüz ortada indirilebilir bir şey bile yok. Sadece süreci paylaşıp fikir almak istiyorum.

---

### 📝 Post #3 — r/webdev (İngilizce, Teknik Deep-Dive)

---

**Title:** `How I designed a plugin SDK that lets anyone build real-time party games for voice rooms — pure reducers, no side effects`

---

I'm building LobbyForge, a self-hostable voice-first community platform. The most interesting technical challenge was designing the **Plugin SDK** — a system that lets developers create games (Taboo, Quiz, Werewolf, Watch Party) that run *inside* voice rooms.

**The constraints:**

- Plugins must be **deterministic** — same state + same action = same result, always
- State must be **serializable** — stored in PostgreSQL JSONB
- Authorization must be **declarative** — no imperative auth checks in plugin code
- Plugins must be **version-tolerant** — state schema can evolve without DB migrations
- Testing must be **isolated** — no Redis, no DB, no network in unit tests
- i18n must be **per-plugin** — each plugin ships its own locale files, no central coordination needed

**The solution: Pure reducer pattern**

Every plugin implements `GamePlugin<TState, TAction>`:

```
createInitialState(ctx) → TState
handleAction(ctx, state, action) → TState  // PURE. No side effects.
migrateState(raw) → TState                 // Idempotent version chain
renderClient(props) → ReactElement
```

The host orchestrates everything:
1. Load state from DB
2. Run `migrateState` (if version mismatch)
3. Validate action via `actionPolicies` (declarative: `host` / `member` / `player`)
4. Overwrite identity fields (`actorFields`) with authenticated session UID
5. Call `handleAction` — pure function, no await
6. Persist new state
7. Broadcast via Redis pub/sub

**9 sub-contexts** give plugins controlled capabilities:

| Context | Purpose |
|---------|---------|
| `players` | List/get participants |
| `timer` | Start/stop countdown |
| `scores` | Add points |
| `voice` | Get voice participants |
| `messages` | Send game chat |
| `cache` | In-memory key-value |
| `pubsub` | Topic pub/sub |
| `votes` | Create polls |
| `state` | Persist (host handles) |

**Action policies — zero imperative auth:**

```typescript
actionPolicies: {
  'start-game': { role: 'host' },
  'answer':     { role: 'member' },
  'vote':       { role: 'player', actorFields: ['voterId'] },
}
```

Unknown action types default to `host` — secure by default.

**Health monitoring as infrastructure:**

The platform includes a Doctor system that auto-profiles the host hardware and recommends capacity limits: voice users/room, camera streams/room, screen shares/room. All checks are pure functions (`SystemStats → DoctorCheck[]`), deterministic, unit-testable. The capacity algorithm considers CPU, RAM, disk pressure, and load average with automatic tier demotion.

**What would you do differently?** Especially interested in:
1. Sub-context pattern vs. traditional dependency injection
2. Plugin-scoped permissions (each plugin defines its own permission set that integrates with the platform's role system)
3. Unified i18n where platform, plugins, and bots share one locale registry with namespace isolation

---

## 11. X (Twitter) İçerik Stratejisi

### Thread Formatı — İlk Paylaşım

> 🧵 1/8
>
> I'm building LobbyForge — an open-source, self-hostable voice platform where you can play games inside voice rooms.
>
> Think Discord, but voice-first, plugin-powered, and you own the server.
>
> Here's what I've built so far 👇

> 2/8 — The Problem
>
> Discord is great, but:
> - You don't own your data
> - No plugin system for voice room activities
> - Guest access is an afterthought
> - Self-hosting? Not possible
> - Privacy? It's their server, not yours

> 3/8 — Voice Rooms + Games
>
> LobbyForge voice rooms can run activities:
> 🎭 Taboo (Hushle) — fully playable
> ❓ Quiz — coming
> 🐺 Werewolf — coming
> 🎬 Watch Party — coming
>
> All built with our Plugin SDK. Games come pre-installed. A marketplace for more is planned.

> 4/8 — Plugin SDK
>
> Pure reducer pattern. No side effects.
> State in → Action → State out.
>
> 9 sub-contexts (timer, scores, voice, etc.)
> Declarative auth. Test harness included.
> Per-plugin i18n. Per-plugin permissions.
>
> You can build your own game in an afternoon.

> 5/8 — Self-Host Stack
>
> 🐳 Docker Compose → up in 3 minutes
> 📦 PostgreSQL + Redis + LiveKit
> 🔐 Ed25519 signed updates
> 🩺 Built-in health monitoring + capacity profiling
> 🔒 Privacy-first: no SEO, invite-only, no telemetry
> 🌍 English + Turkish (community translations welcome)

> 6/8 — Design: "Calm Future"
>
> Not a neon gamer aesthetic.
> Not a Discord skin.
>
> Premium, quiet, trust-evoking.
> Dark palette + ice blue accent + glassmorphism.
>
> [screenshot]

> 7/8 — What's Next
>
> - Bandwidth monitoring + trend analytics
> - Desktop app (Electron)
> - Plugin marketplace (one-click install)
> - More games
> - Community bot SDK
> - Plugin-scoped role permissions

> 8/8 — Try It / Follow Along
>
> 📦 GitHub: [link when ready]
> 📝 Dev log on Reddit: [link]
>
> Would you use this? What games would you want in voice rooms?
>
> RT appreciated 🙏

### X İçin İpuçları

- **Demo GIF/video şart** — tweet'e embed video koy (ses odasında Hushle oynanırken)
- **Screenshot paylaş** — Calm Future design system'in çıktılarını göster
- **Hashtag'ler:** `#opensource #selfhosted #webdev #gamedev #buildinpublic #typescript #nextjs #livekit`
- **Engagement hook:** Her tweet'in sonunda soru sor
- **Düzenli paylaşım:** Haftada 2-3 tweet, her milestone'da thread

---

## 12. Aşamalı Yayın Takvimi

```
Haziran Sonu:
  ├── [23-25] Demo GIF / Video hazırla
  ├── [24-26] README + Docs polish
  ├── [25]    GitHub repo public yap
  ├── [25]    Reddit Post #1 — r/selfhosted (EN)
  ├── [26]    Reddit Post #2 — r/Turkey (TR)
  └── [27]    X Thread #1 — Tanıtım

Temmuz Başı:
  ├── [02]    Reddit Post #3 — r/webdev (EN, teknik)
  ├── [05-12] Quiz plugin tamamla
  ├── [10]    X Thread #2 — Plugin SDK Deep Dive
  └── [15]    Reddit Dev Log #2

Temmuz Ortası-Sonu:
  ├── [15-25] Plugin Hub MVP
  ├── [15-25] DM feature flag (opsiyonel)
  ├── [20]    Reddit r/gamedev — Plugin Games post
  └── [25]    Bandwidth monitoring implementasyonu

Ağustos:
  ├── Bot SDK runtime
  ├── Plugin-scoped permissions
  ├── Unified i18n-core
  └── Desktop app MVP
```

---

## 13. Kritik Öneriler

### ✅ Hemen Yapılması Gerekenler (Post Öncesi)

1. **Demo video / GIF çek** — Hushle oynanırken, ses odasına katılırken, Doctor dashboard, davet linki akışı. Bu olmadan Reddit post'u tutmaz.
2. **README.md yaz** — Her şeyi anlatan, screenshot'lı, badge'li bir README. r/selfhosted bunu bekler.
3. **GitHub repo'yu public yap** — "Repo'yu yakında paylaşacağım" dersen engagement düşer. Link ver.
4. **docker compose up çalışsın** — Birisi clone'layıp `docker compose up` dediğinde çalışmalı.
5. **Lisans seç** — Şu an LICENSE dosyası 15 byte (muhtemelen placeholder). AGPLv3 veya MIT seç.
6. **`registrationMode` varsayılanını `'invite_only'` yap** — self-host için `'open'` kötü varsayılan.

### 🎯 Stratejik Kararlar Özeti

| Karar | Önerim | Gerekçe |
|-------|--------|---------|
| DM | Opsiyonel feature flag | Community platform, messaging app değil |
| Plugin dağıtım | Pre-installed (devre dışı bırakılabilir) + Hub | İlk açılış boş olmamalı, ama şişkin de hissetmemeli |
| Plugin-scoped permissions | Evet, plugin manifest'ten gelen yetki seti | Her rolün hangi plugin'de ne yapabileceğini kontrol |
| Unified i18n | `@lobbyforge/i18n-core` ile namespace'li birleşim | 3 kopya kodu teke düşürür, topluluk çevirisini kolaylaştırır |
| Health bandwidth | Tahmini hesaplama + LiveKit metrikleri | Ses: ~50Kbps, Kamera: ~500Kbps-1.5Mbps, Ekran: ~2-5Mbps |
| Gizlilik varsayılanı | Her şey kapalı, admin açar | Self-host = gizlilik-ilk |
| Lisans | AGPLv3 | Self-host topluluğu bunu sever, ticari fork'u engeller |
| Bot SDK | Runtime'ı ws-gateway'e bağla | WebSocket altyapısı zaten var |
| Desktop | Beklesin | Web app öncelikli |

---

## 14. TL;DR

| Soru | Cevap |
|------|-------|
| **Projeyi ne olarak konumlandırırsın?** | Self-hostable, voice-first community platform with plugin SDK. Yeni bir kategori. |
| **Health sistemi ne yapıyor?** | Otomatik kapasite analizi: ses/kamera/ekran paylaşımı kapasitesi + 10 sağlık kontrolü + 4 seviye alarm. Bandwidth izleme eklenmeli. |
| **Gizlilik ne durumda?** | Schema'da sağlam: SEO kapalı, invite-only, privacy JSONB, güvenlik başlıkları. `registrationMode` varsayılanı değişmeli. |
| **Pluginler kurulu mu gelmeli?** | Hybrid: Hushle + Quiz + Watch Party kurulu, geri kalanı Hub'dan. Hepsi devre dışı bırakılabilir. |
| **Roller özelleştirilebilir mi?** | Evet, ve plugin-scoped permissions eklenmeli. Her plugin kendi yetki setini tanımlar. |
| **i18n nasıl evrensel olur?** | Ortak `i18n-core` + namespace: `platform`, `plugin:X`, `bot:Y`. Tek satırla yeni dil. |
| **Plugin hub nasıl olmalı?** | 3 katman: Official Hub (1-click) + Community Marketplace + DIY. Trust level zaten var. |
| **DM eklemeli mi?** | Hayır, core'da değil. Opsiyonel feature flag. |
| **Reddit'te ne yazayım?** | Yukarıdaki 3 hazır post taslağını kullan. r/selfhosted ilk. |
| **X'te ne paylaşayım?** | 8-tweet thread. Demo GIF şart. #buildinpublic |
| **Ne zaman paylaşayım?** | Demo video + README + public repo hazır olunca. |
