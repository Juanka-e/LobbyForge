# Beta Hazırlık Değerlendirmesi — 2026-09-19

> **Güncelleme (aynı gün): bulgular düzeltildi.** Ayrıntılar §8'de. §1–§7
> incelemenin ilk hâlidir ve tarihsel kayıt olarak korunuyor.

Kapsam: `7e2c913` (main) üzerinde proje durumu, güvenlik incelemesi ve
uçtan uca ses testi. Kod değişikliği yapılmadı; yalnızca yeni bir e2e
spec eklendi (`apps/web/e2e/voice-ui-audio.spec.ts`, commit edilmedi).

## 1. Karar

**Çekirdek ses ve sohbet çalışıyor, ama proje şu hâliyle beta'ya hazır değil.**
README'deki "Closed beta ready" ifadesi şu an doğru değil. Canlı olarak
doğrulanan üç güvenlik açığı moderasyon modelini fiilen geçersiz kılıyor:
moderatörün herkese admin vermesi, ban'ın erişimi kesmemesi ve
moderatör susturmasının atlatılabilmesi. Bunlara ek olarak PTT (web ve
masaüstü) ve güncelleme sonrası ses bağlantısı kırık. Aşağıdaki **P0**
listesi kapatıldığında güvenilir test kullanıcılarıyla kapalı beta'ya
çıkılabilir.

## 2. Yapılanlar ve sonuçlar

| Kontrol | Sonuç |
|---|---|
| `pnpm verify` (build, typecheck, lint, test) | ✅ 1117 test geçti, 0 lint hatası (47 uyarı) |
| Gerçek Postgres DB entegrasyon testleri (3 dosya, 22 test) | ✅ 22/22 (`integration.test.ts` bootstrap edilmiş instance ister ve CI'da koşmuyor) |
| `pnpm audit --prod` | ✅ Açık yok |
| `pnpm audit` (dev bağımlılıkları dahil) | ⚠️ 16 açık, hepsi dev-only (vitest <3.2.6 kritik, happy-dom kritik, vite, eslint zinciri) |
| Docker image (HEAD) + temiz e2e stack | ✅ Build başarılı (dev compose'a 3 düzeltme gerekti, bkz. §5) |
| `compose-stack.spec.ts` (Hushle zinciri) | ✅ 3/3 (temiz volume'da). Eski volume'da 409: kanal başına tek oyun kuralı doğru çalışıyor |
| `voice-two-clients.spec.ts` | ⚠️ 2/3. Testin kendi zamanlama hatası (bkz. §5) |
| **Yeni: gerçek arayüz üzerinden ses testi** (9 senaryo, WebRTC `getStats` ile ölçüm) | 9/9 senaryo koştu, **8 kusur** ölçüldü (bkz. §3) |
| 3 paralel kod denetimi + kritik bulguların canlı doğrulanması | Bkz. §4 |

## 3. Ses: uçtan uca test sonuçları

Test gerçek lobby arayüzünü sürüyor: ses kanalına tıklama, Mute, Deafen
ve PTT tuşu. Sesin gerçekten akıp akmadığını tarayıcının kendi WebRTC
istatistikleriyle ölçüyor (`inbound-rtp` bytes ve `totalAudioEnergy`).

### Çalışanlar (canlı ölçüldü)
- İki yönlü ses: 3 saniyede ~150 paket ve ~28 KB, ses enerjisi > 0. Uzak `<audio>` elementi oynuyor.
- Yerel susturma: dinleyici 0 paket alıyor, susturma kaldırılınca ses geri geliyor.
- Sağırlaştırma (mevcut katılımcılar için): 0 paket, kaldırılınca geri geliyor.
- Sayfa yenileyip yeniden katılma: ses iki yönde de geri geliyor.
- Gerçek zamanlı sohbet (WS gateway): dev compose düzeltmesinden sonra 74 ms'de ikinci kullanıcıya ulaşıyor.

### Kırık olanlar (canlı doğrulandı)
| # | Kusur | Kaynak |
|---|---|---|
| V1 | **PTT çalışmıyor:** Space basılıyken karşı taraf hiç ses almıyor. Tam paket koşularının 2/3'ünde tuş bırakıldıktan sonra mikrofonun açık kaldığı da görüldü (yarış durumu). | `app/lobby/LobbyVoiceProvider.tsx:876-946`: `setMicEnabled` → `toggleMic` yeniden oluşuyor → effect cleanup `held` iken mikrofonu kapatıyor |
| V2 | **Moderatör susturması atlatılabiliyor:** susturulan kullanıcı mikrofonunu kapatıp açınca yeniden duyuluyor. Yeniden katılınca susturma kayboluyor. Kullanıcının arayüzü susturmayı hiç göstermiyor. | `api/servers/[id]/channels/[channelId]/members/[userId]/voice/mute/route.ts:87` yalnızca `mutePublishedTrack` çağırıyor, durum saklanmıyor, `canPublishSources` kısılmıyor |
| V3 | **Sağırlaştırma sızdırıyor:** deafen'dan sonra odaya katılan kişi duyuluyor. | `LobbyVoiceProvider.tsx:328-334`: yalnızca o anki publication'lara `setEnabled(false)` uygulanıyor |
| V4 | **Mikrofon izni yoksa hiç katılamıyor:** yalnızca dinleyici modu yok, kullanıcı ham "Permission denied" metni görüyor. Kaydedilmiş bir cihaz çıkarılmışsa (`{exact}`) aynı sonuç. | `LobbyVoiceProvider.tsx:712` try bloğunun içinde ve catch odadan çıkarıyor |
| V5 | Yeniden katılmalarda eski `<audio>` elementleri birikiyor (duraklatılmış, duyulmuyor). | `detachRemoteAudio` yolu |

### Kırık olanlar (kaynak kodla / izole deneyle doğrulandı)
| # | Kusur | Kanıt |
|---|---|---|
| V6 | **Masaüstü global PTT ve kısayollar hiç çalışmıyor:** `postMessage({source: window, ...})` `DataCloneError` fırlatıyor. Chromium'da tekrar üretildi. Login handoff da aynı yoldan geçiyor. | `apps/desktop/src-tauri/src/lib.rs:245,254,291`. Düzeltme: payload'dan `source:window` çıkarılmalı |
| V7 | **Güncelleme sonrası ses ve realtime kırılıyor:** `NEXT_PUBLIC_LIVEKIT_URL/WS_URL` build anında koda gömülüyor (`livekitUrl:"ws://localhost:7890"` chunk'ta birebir görüldü). Runtime env yok sayılıyor. `release.yml` build-args vermediği için GHCR image'ı `localhost:7880/3001` taşır. İlk kurulum yerel build ettiği için çalışır, `lfctl update apply` sonrası kırılır. | `Dockerfile:10-11`, `.github/workflows/release.yml` (build-push, build-args yok), `app/lobby/page.tsx:563`, `middleware.ts:28` |
| V8 | **Activities sayfasında ses yok:** `/room/...` uzak track'leri attach etmiyor. Lobby'den oraya geçmek lobby ses bağlantısını düşürüyor. | `app/room/[roomName]/page.tsx:164-188` (TrackSubscribed/attach yok) |
| V9 | Arama sırasında çıkış cihazı, giriş/çıkış ses seviyesi ve hassasiyet ayarları uygulanmıyor. Cihaz değişikliği yeniden katılana kadar etkisiz. | `setSinkId` yalnızca ayarlar test sayfasında kullanılıyor |
| V10 | Kişi başı ses seviyesi yeniden bağlanınca uygulanmıyor. iOS'ta `element.volume` salt okunur. | `LobbyVoiceProvider.tsx:352-366` |
| V11 | Autoplay engeli için `startAudio()` / "sesi etkinleştir" akışı yok (Safari ve PTT/sessiz başlangıç senaryolarında sessizlik). | `AudioPlaybackStatusChanged` dinlenmiyor |
| V12 | Aynı kullanıcı iki sekmede ya da masaüstü + tarayıcıda katılınca ilk oturum sessizce düşüyor (`DUPLICATE_IDENTITY`, sebep gösterilmiyor). | `livekit/token/route.ts:152` identity = userId |
| V13 | Kendi mute göstergesi yanlış (track var diye "açık" görünüyor). | `LobbyVoiceProvider.tsx:219` |
| V14 | TURN kimlik bilgileri 1 saatte doluyor ve yenilenmiyor; 60 dakikadan sonraki bir yeniden bağlanma TURN'e bağımlı kullanıcıda başarısız olur. | `lib/turn-credentials.ts:22` |

### Canlı test gerektiren riskler (VPS'te)
- coturn relay port aralığı yalnızca 41 port (49160-49200). 10'dan fazla TURN kullanıcısında tükenebilir.
- `docker-compose.prod.yml:297` bridge modda 10.001 UDP portu yayınlıyor (başlatma süresi ve bellek). `rtc.udp_port` ile tek port düşünülebilir.
- Windows'ta tüm ekran paylaşılırken `shareSystemAudio` açık olduğu için yankı riski var.
- Dev LiveKit `latest` (yerelde v1.13.1), prod ise v1.13.7'ye sabitlenmiş. CI ses testi prod sürümünü sınamıyor.
- Dev ortamında `--node-ip 127.0.0.1` nedeniyle LAN'daki ikinci makine bağlanamıyor; bu yalnızca compose yorumunda yazıyor.

## 4. Güvenlik incelemesi

Web API'si, realtime/plugin/altyapı katmanı ve ses hattı ayrı ayrı
incelendi. Kritik bulgular canlı e2e stack'inde denendi; yapılan tüm
değişiklikler geri alındı.

### Yüksek
| ID | Bulgu | Durum |
|---|---|---|
| S1 | **MANAGE_ROLES → ADMINISTRATOR yükseltmesi.** Moderatör `PATCH /roles/{@everyone}` ile `administrator` ekleyebiliyor; sunucudaki her üye audit log ve ban listesine erişebiliyor. `POST /roles` ile administrator içeren rol de oluşturulabiliyor (201). Sebep: istenen yetkilerin aktörde bulunup bulunmadığı kontrol edilmiyor. | **Canlı doğrulandı** (sıradan üye: audit-logs 403 → 200, bans 403 → 200). `roles/[roleId]/route.ts:196-229`, `roles/route.ts:146-179` |
| S2 | **Ban erişimi kesmiyor.** `banUser` yalnızca `server_bans` satırı ekliyor, üyelik silinmiyor. Banlanan kullanıcı mesaj gönderebiliyor, LiveKit token alabiliyor ve WS aboneliklerini koruyor. Açık kayıtlı instance'ta `/lobby` onu yeniden üye yapabiliyor. | **Canlı doğrulandı** (mesaj 201, token 200). `packages/db/src/queries/bans.ts:65-79`, `app/lobby/page.tsx:462` |
| S3 | **`/lobby` gizli kanalları sızdırıyor.** Rol kısıtlı kanal adları ve id'leri HTML'e gömülüyor. En düşük pozisyondaki metin kanalı gizliyse son 50 mesajı da sızar. | **Kanal adı canlı doğrulandı** (API gizliyor, `/lobby` HTML'i gösteriyor). Mesaj sızıntısı kanal sırasına bağlı (kod incelemesi). `app/lobby/page.tsx:296-332` |

### Orta
| ID | Bulgu | Durum |
|---|---|---|
| S4 | Ses moderasyonu LiveKit'e yansımıyor: susturma atlatılıyor (V2). Kick, ban, timeout ya da rol kaybı kullanıcıyı sesli kanaldan atmıyor (`removeParticipant`/`updateParticipant` hiç çağrılmıyor). `enable_remote_unmute: true` olduğu için `{muted:false}` isteği, kendini susturmuş birinin mikrofonunu açabiliyor. | Susturma kısmı canlı, geri kalanı kod |
| S5 | Realtime presence olayları gizlilik ayarlarını ve engellemeleri yok sayıyor (REST uyguluyor, WS ham olayı iletiyor). | Kod: `api/presence/route.ts:75-84`, `ws-gateway/src/server.ts:495` |
| S6 | WS gateway: her benzersiz topic için yeni bir Redis bağlantısı açılıyor ve var olmayan kanal id'leri yetkili sayılıyor. Bir üye Redis'in `maxclients` sınırını tüketebilir. Rate limiting fail-closed olduğu için sonuç tam kesinti olur. | Kod: `redis-subscriber.ts:72`, `authorize.ts:67,80`, `channelVisibility.ts:87` |
| S7 | Şifre değişikliği, login, OAuth ve masaüstü handoff ile açılan oturumları iptal etmiyor (`recordSession` bu yollarda çağrılmıyor). | Kod |
| S8 | Sesli kanalda görünen ad istemciden alınıyor; biri sahibin adını taklit edebilir. | Kod: `livekit/token/route.ts:35,159` |
| S9 | Yerel `docker build` sırasında `COPY . .` TLS özel anahtarını (`infra/certbot`), yedekleri ve 6.1 GB'lık `src-tauri/target`'ı image'a (plugin-worker dahil) kopyalıyor. GHCR image'ları etkilenmiyor. | `.dockerignore` eksik. Build context 1.7 GB+ olarak **canlı görüldü** |
| S10 | Directory change-domain yeniden onay istemiyor, yeni domain hemen "verified" olarak listeleniyor. | Kod: `directory/change-domain/route.ts:139-161` |
| S11 | "Anonim" anketler ardışık güncellemeler karşılaştırılarak kimin neye oy verdiğini açığa çıkarıyor (`ballotBox` projeksiyonsuz yayınlanıyor). | Kod: `plugins/poll/src/index.ts:202` |

### Düşük
- CREATE_INVITE yetkisi olan (varsayılan @everyone) herkes tüm davetleri listeleyip iptal edebiliyor.
- Sunucu genelindeki presence, gizli sesli kanalın `channelId`'sini veriyor.
- Hushle: `usedCardIds` projeksiyonda kaldığı için takım arkadaşı kartı tahmin edebilir.
- Bitmiş aktivite oturumu yanlış alanı okuyor (`currentState.status`), bu yüzden bitmiş oyunlara aksiyon gönderilebiliyor.
- Quiz cevapları deneme yoluyla bulunabiliyor.

### Doğrulanmayan / yanlış pozitif
- "coturn 4.18.0 IPv6 CIDR yüzünden açılmıyor" iddiası **tekrar üretilemedi**. Sabitlenmiş image, render edilmiş config ile sorunsuz ayağa kalkıyor. IPv6 engellerinin gerçekten uygulandığı ayrıca doğrulanmadı.

### Sağlam bulunan alanlar
Cookie HMAC ve sabit zamanlı karşılaştırma, CSRF/Origin guard (tüm
mutasyonlarda), setup kilidi, OAuth state, desktop handoff (GETDEL),
kanal-sunucu bağ kontrolleri, kick/ban/timeout hiyerarşisi, rate limit
(fail-closed; login'de canlı olarak 429 görüldü), SQL enjeksiyonu yok,
`dangerouslySetInnerHTML` yok, registry SSRF koruması, plugin worker
izolasyonu ve hash pinleme, Tauri ACL, lfctl imza zinciri (Ed25519,
digest pin, downgrade koruması), repo'da secret yok (`.env` gitignore'da
ve hiç commit edilmemiş), test route'ları üretimde kapalı.

## 5. Altyapı, CI ve test bulguları

| # | Bulgu | Etki |
|---|---|---|
| I1 | `docker-compose.dev.yml` → `ws-gateway`'de `working_dir: /app` yok. Dockerfile artık `WORKDIR /app/apps/web` ile bitiyor ve gateway `MODULE_NOT_FOUND` ile **sürekli yeniden başlıyor** (canlı). | Dev/CI stack'inde realtime yok |
| I2 | Aynı serviste `LF_DB_URL` yok, gateway `DATABASE_URL`'i okumuyor. Her abonelik `unknown_topic: LF_DB_URL is not set` ile reddediliyor (canlı). `.env.example` da bu değişkeni anmıyor. | Dev/CI'da sohbet ve presence realtime çalışmıyor |
| I3 | Dev compose'da web servisinde `LIVEKIT_URL` yok. Moderatör susturması 500 dönüyor (canlı). | CI ses moderasyonunu hiç sınamıyor |
| I4 | CI "compose stack" e2e testi I1-I3'ü yakalamıyor: realtime ve arayüz akışları CI'da test edilmiyor, gateway'de healthcheck yok. | Sahte güven |
| I5 | `voice-two-clients.spec.ts:199-201`: bekleme koşulu `events.length > 0` hemen sağlanıyor ve assert yarışa giriyor (3 denemede 1 başarısız). CI'daki 2 retry bunu maskeliyor. Test ayrıca uygulamanın kendi ses kodunu değil sentetik bir harness'ı sınıyor. | Yanlış güven |
| I6 | Playwright config'deki `--disable-web-security` Chromium'un `Origin` başlığını düşürmesine yol açıyor. Gerçek arayüz testleri CSRF guard'a takılıyor (yeni spec kendi tarayıcısını başlatıyor). | Arayüz testlerinde tuzak |
| I7 | `e2e-ports.yml`, ws-gateway için `LOBBYFORGE_APP_ORIGIN` ve web için `NEXT_PUBLIC_*` portlarını ayarlamıyor. Paralel stack'te arayüz yanlış LiveKit'e (7880) bağlanır. | Test altyapısı |
| I8 | `packages/db/src/__tests__/integration.test.ts` CI'da koşmuyor (setup kilidi ve atomik kayıt testleri). | Kapsam boşluğu |
| I9 | Dokümantasyon kayması: README'de "19 audit" yazıyor (gerçekte 31). `VERIFICATION_REPORT.md` 2026-07-21'de kalmış (366 web testi, bugün 885). `BETA_RELEASE.md`'deki 4 VPS maddesi hâlâ açık. | Güvenilirlik |
| I10 | Dev bağımlılıkları: vitest 1.6 (kritik açık), happy-dom (kritik). Yalnızca geliştirme ortamını etkiliyor ama güncellenmeli. | Düşük |
| I11 | İstemci her WS topic'ine iki kez abone oluyor (zararsız ama gereksiz yük). | Düşük |

## 6. Öncelikli yapılacaklar

**P0: beta'dan önce**
1. S1: rol oluşturma/güncellemede aktörün sahip olmadığı yetkiyi (özellikle `administrator`) vermesini engelle.
2. S2: ban, aynı transaction içinde üyeliği silsin. `ensureServerMembership` ve `isServerMember` ban'ı kontrol etsin.
3. S3: `/lobby` görünür kanalları listelesin ve mesajları `authorizeChannelMessageAccess` üzerinden yüklesin.
4. S4/V2: server-mute durumu saklanmalı. `updateParticipant` ile `canPublishSources`'tan mikrofon çıkarılmalı ve token route bunu uygulamalı. `enable_remote_unmute: false` yapılmalı. Kick/ban/timeout durumunda `removeParticipant` çağrılmalı.
5. V1 + V6: PTT effect'i ref tabanlı hale getirilmeli (yalnızca bağlantıya bağlı olsun) ve `blur` ile tuş bırakılmış sayılmalı. Masaüstünde payload'dan `source:window` kaldırılmalı.
6. V7: LiveKit ve WS URL'leri runtime'da okunmalı (sunucu bileşeni ve middleware'de `NEXT_PUBLIC_` olmayan bir env), ya da release image'ı same-origin `/livekit` ve `/ws` yollarını kullanmalı.
7. I1-I4: dev compose düzeltilmeli (`working_dir`, `LF_DB_URL`, `LIVEKIT_URL`) ve `voice-ui-audio.spec.ts` ile bir realtime testi CI'a eklenmeli.
8. V8: aktiviteler lobby içinde açılmalı ya da room sayfası ses attach etmeli.

**P1: beta sırasında**
V3 (yeni katılana deafen uygulanması), V4 (yalnızca dinleyici modu), V13 (mute göstergesi), S5, S6, S7, S8, S9 (`.dockerignore`), I5, I8, BETA_RELEASE'deki VPS maddeleri.

**P2**
V9-V12, V14, S10, S11, düşük önemli bulgular, dev bağımlılık güncellemeleri, dokümantasyon güncellemesi.

## 7. Testi tekrar koşmak

```sh
# e2e stack (dev compose + e2e portları + I1–I3 düzeltmeleri)
export LOBBYFORGE_SETUP_TOKEN=e2e_setup_token_default_0123456789ab \
       NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7890 NEXT_PUBLIC_WS_URL=ws://localhost:3101 \
       LOBBYFORGE_APP_ORIGIN=http://localhost:3100
# Image bu NEXT_PUBLIC_* değerleriyle build edilmiş olmalı (build-arg).
docker compose -p lobbyforge-e2e -f infra/docker/docker-compose.dev.yml \
  -f infra/docker/docker-compose.e2e-ports.yml up -d --wait
cd apps/web
LF_E2E_BASE_URL=http://localhost:3100 LF_E2E_SETUP_TOKEN=$LOBBYFORGE_SETUP_TOKEN \
  npx playwright test voice-ui-audio.spec.ts --workers=1 --reporter=list
```

Son test ("no voice defects observed") §3'teki kusurlardan herhangi biri
geri gelirse kırmızıya döner; regresyon testi görevi görür.

## 8. Düzeltme durumu (2026-09-19)

Tüm düzeltmeler `fix/beta-readiness` dalında. Kritik olanlar, ilk bulguları
üreten aynı canlı stack üzerinde yeniden denendi.

### Doğrulama
| Kontrol | Önce | Sonra |
|---|---|---|
| `pnpm verify` | 1117 test | ✅ 1252 test, 0 lint hatası |
| Gerçek Postgres entegrasyon testleri | 22 (bir kısmı CI dışında) | ✅ 28/28; hepsi CI'da |
| Gerçek arayüz ses E2E (`voice-ui-audio.spec.ts`) | 8 kusur | ✅ 10/10 test, kusur yok (art arda 2 koşu) |
| `voice-two-clients.spec.ts` | 2/3 (yarış) | ✅ 3/3 |
| `compose-stack.spec.ts` | 3/3 | ✅ 3/3 |
| Canlı sömürü betiği (S1/S2/S3) | 10 açık | ✅ 10/10 güvenli |
| WS: sahte topic, limit, presence içeriği | sızıyor / sınırsız | ✅ forbidden, rate limit, `{"type":"presence-update"}` |
| Dev compose (`up --wait`, override olmadan) | gateway çöküyor | ✅ tüm servisler healthy |
| Docker build context | 1.7 GB+ (anahtar dahil) | ✅ 9.7 MB, image'da pem/key/dump yok |

### Bulgu → durum
| Bulgu | Durum |
|---|---|
| S1 yetki yükseltme | ✅ düzeltildi, canlı doğrulandı (403) |
| S2 ban erişimi kesmiyor | ✅ düzeltildi, canlı doğrulandı (mesaj/token/davet/lobby 403) |
| S3 /lobby sızıntısı | ✅ düzeltildi, canlı doğrulandı |
| S4 ses moderasyonu | ✅ kalıcı mute + canlı izin güncellemesi + oda tahliyesi; canlı doğrulandı (toggle ve rejoin ile atlatılamıyor, uzaktan mic açılmıyor) |
| S5 presence gizliliği | ✅ WS yük taşımıyor; SSR ve REST aynı projeksiyonu kullanıyor; gizli durum `lastSeen` ile sızmıyor |
| S6 WS Redis tüketimi | ✅ paylaşımlı subscriber, kanal varlık kontrolü, bağlantı başına 64 ve kullanıcı başına 256 limit; IP slot sızıntısı düzeltildi |
| S7 şifre değişikliği oturumları | ✅ tüm giriş yolları oturumu kaydediyor (+ Google girişi hiç çalışmıyordu, düzeltildi) |
| S8 ses adı taklidi | ✅ ad sunucu tarafında çözülüyor |
| S9 image'a sızan dosyalar | ✅ `.dockerignore` + CI kontrolü |
| S10 domain değişikliği | ✅ aynı anahtar şartı + yeniden onay |
| S11 anket anonimliği | ✅ `ballotCount` + izleyiciye özel `hasVoted` |
| Hushle kart id, biten oturum, quiz yoklama | ✅ düzeltildi |
| V1 PTT | ✅ canlı doğrulandı |
| V2 moderatör susturması | ✅ canlı doğrulandı |
| V3 sağırlaştırma sızıntısı | ✅ canlı doğrulandı |
| V4 mikrofon yoksa katılamama | ✅ canlı doğrulandı (dinleyici modu) |
| V5 hayalet ses elementleri | ✅ canlı doğrulandı |
| V6 masaüstü PTT/kısayollar | ✅ Rust birim testleri; gerçek işletim sistemlerinde elle doğrulanmalı |
| V7 release image'da localhost | ✅ runtime çözümleme + CI kontrolü |
| V8 aktivite sayfasında ses | ✅ ses bağlanıyor |
| V9–V14 | ✅ çıkış cihazı, ses seviyesi, autoplay, kopma sebebi, kendi mute göstergesi, TURN süresi 12 saat |
| I1–I11 | ✅ I10 (dev bağımlılık yükseltmesi) hariç hepsi |
| coturn CIDR | ⚪ yanlış pozitif (tekrar üretilemedi) |

### Açık kalanlar
- **VPS provası** (`BETA_RELEASE.md`): temiz kurulum, gerçek `lfctl update apply`, zorlanmış hata, yedekten geri dönüş.
- **Masaüstü:** Windows, macOS ve Linux'ta global PTT ile kısayolların elle denenmesi. Kod imzalama (ADR-005).
- **Dev bağımlılıkları:** vitest 1.6 → 3.x ve happy-dom → ≥20.8.9 (yalnızca geliştirme ortamı; ayrı bir PR önerilir).
- **Kapasite:** coturn relay port aralığı (41 port) ve prod compose'daki 10.001 UDP port yayını VPS'te ölçülmeli.
- **Politika kararları:**
  - Engelleyen kişinin presence'ının engellenene gösterilmesi.
  - Yönetici olmayan adminlerin `administrator` içeren rolleri dağıtamaması (Discord'dan daha katı).
- **Arayüz:** `/login` sayfası `?error=` kodlarını göstermiyor (ör. `registration_closed`).
- **Operasyon:** release imzalama özel anahtarı (`infra/keys/`) repo klasöründe duruyor. Artık image'a girmiyor, ama klasör dışında (parola yöneticisi, donanım anahtarı) tutulması önerilir. Eski yerel image'lar Rust build çıktısı yüzünden 23–26 GB; `docker image prune` ile temizlenebilir.

