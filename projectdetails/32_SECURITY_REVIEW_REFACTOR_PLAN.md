# Security Review and Refactor Plan

Bu not 2026-06-11 proje incelemesinden sonra yazildi. Amac, yeni plugin/game/bot eklendikce sistemin karismamasini ve official catalog + self-host kurulum modelinin guvenli ilerlemesini saglamaktir.

## Catalog and install decision

Yeni app, plugin, game veya bot tek bir `App Catalog` modeliyle tanimlanacak.

- Her app bir manifest ile gelir: `id`, `kind`, `category`, `capabilities`, `permissions`, `runtime`, `minHostVersion`, `settingsSchema`, `trustLevel`, `publisher`, `signature`.
- Kategori modeli: `Game`, `Bot`, `Integration`, ileride `Theme` veya `Workflow`.
- Catalog karti kullaniciya ne oldugunu gosterir; kurulum ekrani admin'e hangi yetkileri istedigini gosterir.
- Self-host instance sahibi catalog'dan app secer, instance'ina tek tikla kurar, sonra local admin panelinde configure eder.
- Registry'de listelenen instance'lar da ayni akisi kullanabilir; registry sadece kesif ve handoff yapar, asil kurulum/ayar/kayit local instance'ta biter.
- Community app'ler ilk etapta kapali kalmali. Once official app'ler, imzalama, capability allowlist, sandbox, audit log ve rollback tamamlanmali.

Bu yapi ile ileride oyun veya bot eklemek ana lobby akisini dagitmaz; yeni ozellikler manifest + adapter + UI slot'lari uzerinden eklenir.

## P1 findings

1. LiveKit token endpoint'i room yetkisini dogrulamiyor.
   - Dosya: `apps/web/app/api/livekit/token/route.ts`
   - Kanit: `room` body'den aliniyor, `readGuestSession` sonrasi `body.room` ile token uretiliyor.
   - Risk: Giris yapmis herhangi bir session, regex'e uyan herhangi bir LiveKit odasi icin token alabilir.
   - Refactor: Token istegi `serverId` + `channelId` veya imzali room context tasimali. Endpoint server membership, channel match ve `CONNECT_VOICE`/ilgili permission kontrolu yapmali.

2. Activity action host katmani action yetkisi ve payload semasi uygulamiyor.
   - Dosya: `apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`
   - Kanit: `ActionSchema` sadece `type` kontrol ediyor; kalan alanlar plugin'e oldugu gibi gidiyor.
   - Risk: Her server member oyunu manipule edebilir; host-only action, player-only action ve actor binding yok.
   - Refactor: SDK'ya action policy eklenmeli: `hostOnly`, `playerOnly`, `actorBoundFields`, `schema`. Route bu policy'yi plugin'e girmeden once dogrulamali.

3. Official oyun plugin'leri client payload'una guveniyor.
   - Dosyalar: `plugins/quiz/src/index.ts`, `plugins/hushle/src/index.ts`, `plugins/vampire-village/src/index.ts`, `plugins/watch-party/src/index.ts`
   - Kanit: `set-questions`, `start-round`, `assign-roles`, `set-video`, `vote`, `join` gibi action'lar actor/host/oyuncu dogrulamasi yapmadan state degistiriyor.
   - Risk: Oyun butunlugu bozulur, oyuncu baskasi adina oy verebilir veya skoru degistirebilir.
   - Refactor: Once host route policy, sonra plugin reducer'larinda actor-aware action yapisi.

## P2 findings

1. Presence POST membership/channel kontrolu yapmiyor.
   - Dosya: `apps/web/app/api/presence/route.ts`
   - Kanit: POST tarafinda `setUserPresence(session.uid, body.serverId, body.channelId, body.status)` dogrudan cagiliyor; GET tarafinda ise membership kontrolu var.
   - Risk: Kullanici baska server/channel icin presence yazabilir.
   - Refactor: POST icin `server exists`, `isServerMember`, channel server match kontrolu eklenmeli.

2. Rate limit key'leri route genelinde statik.
   - Dosya: `apps/web/lib/security-headers.ts`
   - Kanit: `withApiSecurity` sadece verilen `identifier` ile `inMemoryRateLimit` cagiriyor.
   - Risk: Bir kullanici route bucket'ini herkes icin tuketebilir; cok instance/process'te tutarsiz davranir.
   - Refactor: Key `route + sessionId/userId/ip` olmali; production icin Redis tabanli limiter eklenmeli.

3. Oda basina tek aktif activity invariant'i uygulanmiyor.
   - Dosya: `apps/web/app/api/servers/[id]/channels/[channelId]/activities/route.ts`
   - Kanit: GET `listGameSessionsForChannel` kullaniyor, POST ise mevcut aktif session var mi kontrol etmeden `createGameSession` cagiriyor.
   - Risk: Ayni voice room'da birden fazla aktif oyun baslar.
   - Refactor: DB unique partial index veya transaction-level check: `channelId + status in active states` tekil olmali.

4. Admin health/doctor yuzeyleri admin guard'a bagli degil.
   - Dosyalar: `apps/web/app/api/doctor/route.ts`, `apps/web/app/admin/health/page.tsx`
   - Kanit: Kod yorumunda `/api/doctor` icin unauthenticated skeleton oldugu belirtilmis; admin page de dogrudan `collectDoctorReport` cagiriyor.
   - Risk: Sistem kapasite/check bilgileri gereksiz acik kalir.
   - Refactor: Admin role guard, public health icin sadece minimal `/api/health`.

5. Message metadata kullanici kontrollu arbitrary JSON.
   - Dosya: `apps/web/app/api/servers/[id]/channels/[channelId]/messages/route.ts`
   - Kanit: `metadata: z.record(z.string(), z.unknown()).optional()`.
   - Risk: Ileride UI metadata'yi trusted system/plugin alanlari gibi yorumlarsa spoofing olur.
   - Refactor: User metadata ve system/plugin metadata ayrilmali; reserved key'ler client tarafindan kabul edilmemeli.

6. Cookie-auth state-changing route'larda CSRF/Origin guard yok.
   - Dosya: `apps/web/lib/security-headers.ts`
   - Risk: SameSite=Lax yardim eder ama uzun vadede yeterli sinir degil.
   - Refactor: Browser cookie auth icin Origin allowlist + CSRF token; bot/API token route'lari ayrica bearer/capability auth kullanmali.

7. Redis presence listeleme `KEYS` kullaniyor.
   - Dosya: `apps/web/lib/redis.ts`
   - Risk: Buyuyen instance'ta Redis bloklanabilir.
   - Refactor: Set indexleri veya `SCAN` kullanilmali.

8. Test reset route'lari sadece `NODE_ENV === "test"` ile korunuyor.
   - Dosyalar: `apps/web/app/api/test/db-reset/route.ts`, `apps/web/app/api/test/redis-reset/route.ts`
   - Risk: Yanlis environment deployment'inda yikici endpoint acik kalabilir.
   - Refactor: Test-only build guard veya internal secret zorunlulugu.

## P3 findings

- Next ESLint plugin uyarisi var.
- `apps/web/app/api/servers/[id]/members/route.ts` icinde unused import var.
- `apps/web/lib/livekit.ts` ve bazi testlerde `no-explicit-any` uyarilari var.
- ~~Dependency audit tamamlanamadi.~~ 2026-06-22 tarihinde tamamlandi.
  Drizzle SQL identifier injection, PostCSS XSS ve esbuild Windows dev-server
  bulgulari yamali surumlere yukseltildi; `pnpm audit --prod` sifir bulgu.

## 2026-06-22 setup ve web boundary hardening

- Setup tamamlanma durumu `bootstrap_version = 2` ile geri donulemez hale
  getirildi. Owner veya ilk server kaydi kaybolsa da public `/setup` acilmaz.
- PostgreSQL advisory transaction lock'i gercek DB uzerinde iki eszamanli
  bootstrap istegiyle test edildi: biri basarili, digeri `already complete`.
- Production setup token'i zorunlu ve sabit-zamanli karsilastiriliyor.
- Setup gorunen metinleri HTML delimiter/control character reddediyor; DB
  yazimlari Drizzle parametreleriyle yapiliyor.
- Global CSP, HSTS, frame/object engeli, MIME sniff engeli ve Permissions-Policy
  tum web route'larina uygulandi.
- Self-host production lobby DB hatasinda demo veri gostermiyor; fail-closed
  unavailable ekrani donuyor.

## 2026-06-22 OWASP/API audit follow-up

`security-audit`, API security ve broken-authentication kontrol listeleriyle
ikinci bir kaynak kod + localhost sinir denetimi yapildi.

- **Kapatildi - admin dev bypass:** `NODE_ENV !== production` artik yonetici
  yetkisi vermiyor. Admin API ve server-rendered admin sayfalari sadece geri
  donulemez setup kaydindaki owner session'i veya en az 32 karakterlik acil
  durum token'i kabul ediyor. Token sabit-zamanli karsilastiriliyor.
- **Kapatildi - zayif guest RNG:** guest kimlikleri `Math.random()` yerine
  `crypto.randomBytes(16)` ile uretiliyor.
- **Kapatildi - hata detayi sizintisi:** API cevaplarindan ham
  `Error.message`/Zod parse detaylari kaldirildi. Kaynak invariant testi bunun
  geri gelmesini engelliyor.
- **Kapatildi - mutation kaynak tuketimi:** shared API boundary varsayilan 1 MB
  `Content-Length` siniri uyguluyor; avatar route'u kontrollu istisna kullaniyor.
- **Kapatildi - ek CSRF sinyali:** mutation isteklerinde
  `Sec-Fetch-Site: cross-site` Origin olmasa bile reddediliyor.
- **Kapatildi - test reset fail-open:** reset endpoint'leri test modunda dahi
  en az 32 karakterlik exact token olmadan calismiyor.
- **Kapatildi - update manifest gevsekligi:** manifest alanlari/komutlari katı
  allowlist ve boyutlarla dogrulaniyor; production remote kaynak HTTPS,
  redirectsiz, 10 saniye ve 1 MB sinirli.

Son test/build tekrarinin arac calistirma kotasi tarafindan reddedildigi turda
bu son grup `verification pending` olarak kalmistir; onceki admin-auth/RNG ve
request-boundary gruplari 294 web testi, typecheck ve lint ile gecmistir.

## Implementation order

## 2026-06-23 audit follow-up

- **Kapatildi - voice mute oda karisikligi:** mute endpoint'i artik room'u
  body'den almiyor; `serverId + channelId` ile server-side LiveKit room adi
  turetiyor. Operator uyeligi, hedef uyeligi, kanal server match'i, voice/stage
  tipi ve `MUTE_MEMBERS` izni birlikte dogrulaniyor.
- **Kapatildi - Origin eksikligi:** production mutation isteklerinde Origin
  header'i yoksa shared API boundary 403 donuyor; Origin varsa request URL,
  `LOBBYFORGE_APP_ORIGIN` veya `NEXT_PUBLIC_BASE_URL` allowlist'iyle
  karsilastiriliyor.
- **Kapatildi - ws-gateway production fallback:** production'da `REDIS_URL`
  zorunlu, browser WebSocket upgrade'leri Origin allowlist'ten geciyor ve
  gateway DB baglantisi `@lobbyforge/db.createDb` ile gercek Postgres'e
  baglaniyor.
- **Kapatildi - chat/activity subscriber kopmasi:** ayni topic'e birden fazla
  listener varken ilk close artik Redis aboneligini kapatmiyor; refcount sifira
  indiginde unsubscribe/quit yapiliyor.
- **Kapatildi - update event log sizintisi:** update command event
  metadata'sindan ham stdout/stderr chunk'lari kaldirildi; sadece byte/truncate
  bilgisi saklaniyor.

1. Auth/permission boundary refactor: shared `resolveSession`, `requireServerMember`, `requirePermission`, `requireChannelInServer`.
2. LiveKit token endpoint'ini server/channel permission ile kilitle.
3. Presence POST membership/channel kontrolunu ekle.
4. Activity session invariant'i: oda basina tek aktif session.
5. Plugin action policy ve action schema host dogrulamasi.
6. Official plugin'leri actor-aware hale getir.
7. Rate limit key modelini user/ip scoped yap; production icin Redis limiter planla.
8. Admin health/doctor guard ve public/minimal health ayrimi.
9. App Catalog install/configure akisini manifest + signed handoff + local admin approval olarak implement et.
10. CSRF/Origin guard ve metadata reserved-key ayrimini ekle.
