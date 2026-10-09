# Etkinlikler: hile denetimi ve kopma dayanıklılığı — 2026-10-09

Sahibin soruları:
1. Etkinliklerin durumu ne? Sesteyken farklı bir arayüz açılıp orada mı
   oynanıyor?
2. Hile ve kötüye kullanım olmamalı.
3. Sesten düşen ya da interneti kopan oyuncular için çözüm: rolleri vb. ne
   kadar tutulacak? Ayrıntılı düşünelim.

Bu belge kod okunarak yazıldı (commit `aad7725`). Ürün kodunda değişiklik
yapılmadı. Satır numaraları bu commit'e göre.

## Karar / Öneri

- **Temel sağlam.** Altı yerleşik oyunun hepsi sunucuda çalışıyor.
  - İstemci yalnızca niyet gönderiyor; kimlik oturum çerezinden geliyor.
  - Gizli bilgi her yolda sunucuda süzülüyor.
  - Saatler sunucu saatine bağlı, rastgelelik CSPRNG.
  - **Yüksek önemde açık bulunmadı.**
- **Asıl riskler host ve çift hesap.** Host çoğu zaman aynı zamanda oyuncu ve
  bazı yetkileri iz bırakmıyor:
  - Vampire Village'da (VV) host geceyi "herkes oynadı" gibi görünen bir anda
    bitirebiliyor (B-01).
  - Oyunun ortasında birini çıkarmak onun rolünü de açıklıyor (B-02).
  - Bir kişi iki hesapla iki koltuk alabiliyor (B-03).
  - Kopan bir oyuncunun rolü, gecenin uzamasından anlaşılıyor (B-04).
- **Kopma: bugün hiçbir oyun kopmayı bilmiyor.** Koltuk, rol ve takım süresiz
  tutuluyor. Sesten düşen yalnızca eylem yapamıyor. Tek kural, host'un 60 sn
  sonra devredilmesi.
- **Öneri: host devriyle aynı tembel (lazy) tasarımda tek bir "varlık"
  modeli.**
  - 10 sn'ye kadar kopma titreme sayılır.
  - Sonra "Bağlantı koptu" rozeti ve geri sayım başlar.
  - Host 60 sn'de devredilir (zaten var).
  - Koltuk VV'de 3 dk, Hushle ve Quiz'de 5 dk tutulur.
  - Yalnız Hushle bekler: anlatıcı ya da host düşerse tur saati durur, en
    fazla 60 sn. Başka hiçbir oyun beklemez.
- **Ses sorunu:** Sayfa yenilenince ses düşüyor ve geri gelmiyor. Önce
  şunlar (P0, ~2 gün):
  - sese tek tıkla dönüş;
  - açık görünümün geri gelmesi;
  - panelde kalıcı bir **Sese katıl** düğmesi.

  Otomatik dönüş yalnızca mikrofon izni zaten verilmişse.
- **Plan:**
  - **P0, ~1 hafta:** ses dönüşü, gerçek zamanlı yeniden eşitleme, ağ
    hatasında aynı `actionId` ile yeniden deneme, eskimiş niyet koruması.
  - **P1, ~3 hafta:** varlık modeli, oyun kuralları, host müdahalelerinin
    herkese görünmesi.
  - **P2:** ayrıntılar.

## 1. Bugünkü durum

### 1.1 Etkinlik nerede açılır?

Kısa cevap: evet, ama ayrı bir ekran ya da ayrı bir çağrı değil.

- **Bağlı olduğu yer.** Etkinlik bir sesli kanala bağlı. Bir kanalda aynı anda
  tek etkinlik olur (`409 activity_exists`).
- **Kim başlatır.** "Etkinlik başlat" izni gerekir; varsayılan olarak yalnız
  yöneticilerde.
- **Nerede açılır.** Lobinin orta sütununda **Etkinlikler** görünümü olarak
  (`apps/web/app/lobby/LobbyActivityView.tsx`). Üç yerden girilir:
  - kenar çubuğunda **Birlikte oyna**;
  - görüntü ekranında **Bu odadaki etkinlikler**;
  - kanal başlığı.
- **Ses kesilmez.** Sohbet, görüntü ızgarası ve etkinlik arasında geçiş
  yapınca ses devam eder. LiveKit bağlantısı lobi boyunca yaşar
  (`LobbyVoiceProvider`).
- **Görünüm.** Etkinlik yokken kurulu uygulamaların kartları görünür. Çalışan
  bir etkinlik varsa:
  - üstte bir durum şeridi: oyun, oyuncu sayısı, host rozeti, **Bitir** ve
    host uzaktaysa bir not;
  - altında oyunun kendi paneli: resmî eklentilerde React, pazar yerindekilerde
    korumalı iframe.
- **Oyun sunucuda çalışır.** Panel her eylemi
  `POST …/activities/{id}/actions` ile gönderir. Yeni durumu ws-gateway'den
  alır; gateway yoksa 5 sn'de bir yoklar.
- **Eski oda sayfası.** `/room/<kanal>` sayfası (sunucu sayfasından bağlantı)
  aynı oturum kancasını (`useActivitySession`) kullanır.

### 1.2 Seste olan, olmayan, izleyici

- **İzlemek hiçbir zaman ses istemez.** Kanalı görebilen her üye çalışan oyunu
  izler. Herkes durumun yalnız kendine düşen kısmını alır.
- **Ses isteyen oyunlar:** Hushle, Quiz, VV, Watch Party ve sandbox buzzer.
  - Oyuncu eylemleri için o kanalın LiveKit odasında olmak gerekir. Yoksa
    `403 voice_required` döner: "Oynamak için sesli kanala katıl."
  - Bugün bu yalnızca bir hata metni; katıl düğmesi yok.
  - Host eylemleri ses kontrolünden geçmez. Oyundan ayrılmak (`leave`)
    dışarıdan da olur.
- **Poll ve Dice ses istemez:** Kanalı gören herkes oynar.
- **Seste değilsen hub sunucunun ilk sesli kanalına açılır**
  (`app/lobby/page.tsx:1199-1202`). Oyun başka bir kanaldaysa onu görmek için
  o kanala girmek gerekir. Bu küçük bir UX boşluğu.
- **İzleyicinin gördükleri:**
  - **Hushle:** skor, takımlar, saat. Kart görünmez.
  - **Quiz:** sorular ve cevap dağılımları. İstediği an katılır, sonraki
    sorudan oynar.
  - **VV:** herkese açık pano, olay kaydı, oylar ve sohbet. Kendi rolü (`me`)
    olmaz, sohbete yazamaz.
  - **Watch Party:** aynı video. Panel açılınca listeye katılmayı dener; seste
    değilse reddedilir ve kontrol edemez.

### 1.3 Telefonda

- **Yerel mobil uygulama yok.** Telefon = mobil tarayıcı; masaüstü uygulaması
  Tauri.
- **Kenar çubuğunun tamamı bir çekmecede** (menü düğmesi). **Birlikte oyna**
  oradan açılır; etkinlik tüm genişliği kaplar.
- **Başlık menü düğmesine yer bırakır** (`pl-16`). "Kapat" yazısı dar ekranda
  simgeye iner. Watch Party'nin yan paneli oynatıcının altına iner.
- **Ses kontrolleri ve "Yeniden bağlanıyor…" yazısı** kenar çubuğunun altında
  (`LobbyVoiceFooter`), yani telefonda çekmecenin içinde. Oyun açıkken
  oyuncu sesten düştüğünü görmez. 3.2'deki panel şeridi bunu da çözer.

### 1.4 Oyunlar

| | Oyuncu | Ses şartı | Host yetkileri | Gizli bilgi | Saatler |
|---|---|---|---|---|---|
| **Hushle** | 4–12; takım başı 2 (vars.), tek sayıda bir "floater" | Var (BUST dahil) | Neredeyse her şey: paket, takımlar, turu başlat, anlatıcı, **Bildi / Pas / Ceza**, sonraki kart, turu ve oyunu bitir | Deste ve kullanılan kart kimlikleri hiç gitmez. Kart yalnız anlatıcıya ve rakip takıma gider | Tur başına tek saat (vars. 60 sn, en çok 300). Sunucuda `endsAt` + 2 sn; sonra puanlama kapanır, sonraki turu host başlatır. **Duraklatma yok** |
| **Quiz** | 1–32 | Var (`join`, `answer`, `time-up`) | Başlat, göster, sonraki soru, bitir, tekrar oyna | Cevaplı deste hiç gitmez. Kimin neyi seçtiği hiç gitmez; yalnız sayılar ve kendi cevabın | Soru başına 10/20/30 sn; sunucuda `deadline` + 1 sn. `time-up`'ı herkes gönderir, sunucu saati geçmeden işe yaramaz. Sonraki soru host'ta |
| **Vampire Village** | 5–12, 50 izleyici | Var (`leave` hariç) | Ayarlar, başlat, çıkar, fazı bitir, duraklat ve sürdür, ±süre, tekrar oyna, bitir | Roller, gece seçimleri, notlar ve sürü sohbeti `state.secret` altında; herkes yalnız `me`'yi görür. Ölenin rolü açılır; oyun bitince her şey açılır | Rol 10, gece 15–180 (30), şafak 5, gün 30–600 (90), oylama 15–180 (30), hüküm 5 sn. Fazın bitişi sunucu saatiyle; istemciler `timeout` ile dürter (1 sn tolerans) |
| **Watch Party** | Listede 1–50 | Var (`leave` hariç) | Parti host'u: video, sıra, oynat/duraklat/sar, kontrol modu, devret. Oturum host'u: `take-host` | Yok, durum herkese açık | Zaman çizelgesi sunucu saatinde. Parti host'u 150 sn sessiz kalırsa biri devralabilir. İzleyici 12 dk'da "uzakta" olur |
| **Poll** | 2–50 | Yok | Aç, kapat, yeniden aç, temizle | Kimin oy verdiği gizli; yalnız sayılar ve "oy verdin mi" | Yok |
| **Dice Bot** | 1–50 | Yok | Aç/kapat, istatistiği sıfırla, geçmişi temizle | Yok, atışlar açık | Yok |
| **Pazar yeri (sandbox)** | Manifestte | Manifestte `requiresVoiceRoom` | Manifestteki `actionPolicies` | Yalnız eklentinin kendi `projectState`'i. Yoksa durum herkese açık (lobi uyarır) | Eklentinin kendisi (`ctx.now`, host'un verdiği CSPRNG listesi) |

## 2. Hile ve kötüye kullanım denetimi

### 2.1 Doğrulanan, sağlam olanlar

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| Sunucu otoriter mi? | Evet. Altı oyunun da reducer'ı sunucuda; istemci yalnız `{type, …}` gönderir. Okuma, reducer ve yazma oturum kilidi + CAS altında | `actions/route.ts:478-505` |
| Başkası adına oynamak | Olmaz. Kimlik alanları (`playerId`, `voterId`, `bustedBy`, `actorId`…) sunucuda çerezdeki kullanıcıyla ezilir. Bilinmeyen eylem türü host'a düşer (`Object.hasOwn`; `constructor` hilesi kapalı) | `actions/route.ts:72-79, 145-148` |
| Sırası ya da fazı değilken | Reducer'lar faz, sıra, takım ve canlılık kontrol ediyor. Host'un ön kontrolü ve bitmiş oyun koruması (`restartActions`) ek kemer | VV `reducer.ts:538-564, 727-739, 785-826`; Quiz `actions.ts:442-460`; Hushle `actions.ts:178-190, 431-451` |
| Öldükten sonra oynamak (VV) | Olmaz. Gece eylemi, oy, sohbet ve sürü sohbeti yaşayan oyuncu ister | VV `reducer.ts:540, 729, 792, 809` |
| İki kez oy, geçersiz hedef | VV'de oy değiştirilebilir, son oy sayılır (kural gereği); hedef yaşamalı ve kendisi olmamalı. Poll'da kişi başına bir oy. Quiz'de soru başına bir kilitli cevap | VV `reducer.ts:727-739`; Poll `index.ts:212-224`; Quiz `actions.ts:442-460` |
| Gösterimden sonra cevap (Quiz) | Olmaz. `reveal` fazında host ve reducer reddeder; süre + 1 sn'den sonra reddedilir. O son 1 sn'deki cevap hız puanı almaz | `actions/route.ts:191-193`; Quiz `actions.ts:452` |
| Kendi rolünü ya da takımını seçmek | Olmaz. VV'de roller CSPRNG ile dağıtılır; `start` istemciden hiçbir şey taşımaz. Hushle takımlarını host kurar | VV `reducer.ts:428-465` |
| Saat hilesi | Bitişler state'te mutlak sunucu zamanı; yeniden bağlanmak saati sıfırlamaz. Erken `timeout` ya da `time-up` hiçbir şey yapmaz | VV `reducer.ts:280-287`; Quiz `actions.ts:489-492`; Hushle `actions.ts:66-70` |
| Rastgelelik | Hushle kart çekimi, VV rol dağıtımı, Quiz deste ve şık karıştırma, zar: hepsi `crypto.getRandomValues`. İstemci tohum veremez. Sandbox, host'tan CSPRNG listesi alır | `plugins/*/src/random.ts`; VV `reducer.ts:73-81`; ADR-007 |
| Gizli bilgi, her yol | REST `GET`, eylem yanıtı, SSE ve WebSocket aynı projeksiyondan geçer. Bus'ta durum yok, yalnız `status`, `revision` ve `publicSummary` (deste boyutu, `rosterChanged`) var. Gateway her izleyici için ayrıca projeksiyon yapar; hata olursa durumsuz olay gider, ham durum asla gitmez | `packages/core/src/activity-projection.ts`; `ws-gateway/src/server.ts:97-137` |
| Oyun sonu | VV her şeyi açar (kural). Quiz yalnız sayıları gösterir, kim neyi seçti bitişte de açılmaz. Hushle destesi ve Poll'un oy sandığı hiçbir zaman gitmez | `activity-projection.ts:136-145, 161-164, 263` |
| Denetim kaydı ve loglar | Oyun eylemleri denetim kaydına yazılmaz; yalnız host eylemleri, tür adıyla, hedefsiz yazılır. Loglarda durum ya da eylem gövdesi yok | `actions/route.ts:577-587` |
| Geçmiş ve eklenti deposu | Biten oturum API'den okunamaz (`getGameSessionById` bitenleri dışlar). Eklenti deposu yok (`/api/internal/plugin-storage` kullanılmıyor) | `queries/gameSessions.ts` |
| Watch Party sırası | Sır yok. Video kimliği (URL değil), `addedBy`, izleyicinin `lastSeenAt`'i: hepsi tasarım gereği açık | `plugins/watch-party/src/state.ts` |
| Tekrar (replay) | `actionId` oturum başına 10 dk geçerli ve yalnız dürüst istemcinin yeniden denemesini tekilleştirir. Başkasının isteğini tekrarlamak çerezini gerektirir. Kendi isteğini tekrarlamak, yeniden oynamak demektir | `lib/action-idempotency.ts` |
| Taşma | Oturumda kullanıcı başına 90 eylem/dk, adres başına 600 yedek. Gövde en çok 1 MiB. VV sohbeti faz başına 10 mesaj ve 200 karakter, sürü sohbeti 12 mesaj. WP sırası 25 (kişi başına 3). Quiz en çok 50 soru | `actions/route.ts:48-50`; VV `state.ts:242-249` |

Not: Host'un faz ön kontrolü, kilitten önce okunan ve migrasyondan geçmemiş
satıra bakıyor (`actions/route.ts:108, 342`). Bu yalnız ek bir kemer, asıl
kontrol reducer'da. Açık değil.

### 2.2 Bulgular

| No | Önem | Başlık | Yer |
|---|---|---|---|
| B-01 | Orta | VV: host geceyi iz bırakmadan bitirebiliyor | VV `reducer.ts:108-109, 305-316` |
| B-02 | Orta | VV: oyunda çıkarmak hem öldürüyor hem rolü açıklıyor | VV `reducer.ts:389-399, 833-853` |
| B-03 | Orta | Çift hesap (misafir + hesap, iki tarayıcı) | Eylem politikaları: yalnız üyelik + ses |
| B-04 | Orta-Düşük | VV: kopan oyuncunun rolü gecenin uzamasından anlaşılıyor | VV `reducer.ts:489-503, 506-519` |
| B-05 | Düşük-Orta | Gerçek zamanlı olay sayısı yan kanalı (VV gecesi) | `actions/route.ts:564-570`; `server.ts:121-130` |
| B-06 | Düşük-Orta | Eskimiş niyet: Hushle "Bildi", Quiz cevabı ve Poll oyu yanlış karta, soruya ya da ankete düşebilir | Hushle `actions.ts:178, 402, 422-429`; Quiz `actions.ts:442`; Poll `index.ts:212` |
| B-07 | Düşük-Orta | Kaybederken bitirme; sonuç kaydı yok | Hushle `actions.ts:465`; Quiz `actions.ts:501`; `end/route.ts:93-131` |
| B-08 | Düşük | Zar: tekrar tekrar atıp kötü atışı geçmişten itmek | Dice `index.ts:185-212` |
| B-09 | Düşük (erişilebilirlik) | Gateway'de her olay için abone sayısı kadar DB okuması | `ws-gateway/src/server.ts:105` |
| B-10 | Düşük | SSE yolu sandbox projeksiyonunda bağlantı anındaki host'u kullanıyor | `stream/route.ts:151-155` |
| B-11 | Bilgi | Etkinlik oyuncu listesi "Görünmez" durumunu atlıyor | `[sessionId]/route.ts:112-179` |
| B-12 | Bilgi | LiveKit'e ulaşılamazsa ses şartı atlanıyor; 2 sn önbellek | `lib/activity-voice.ts:58, 107-116` |
| B-13 | Bilgi | Yerleşik Quiz cevapları ve Hushle kartları açık depoda | `plugins/quiz/src/packs/data/*.ts` |
| B-14 | Bilgi | Quiz: soruları yazan host cevapları biliyor; yalnız uyarı var | `docs/QUIZ.md` |
| B-15 | Bilgi | Biten oturumların gizli durumu süresiz DB'de kalıyor | `queries/gameSessions.ts` (temizlik yok) |

**B-01 — VV: host geceyi iz bırakmadan bitirebiliyor.**
- **Senaryo:** Host aynı zamanda vampir. Sürünün ısırma oyu girer girmez
  **Geceyi bitir** der; kâhin ve doktor seçim yapamaz.
- **Neden görünmüyor:** Herkes gecenin erken bittiğini görür. Ama gece, herkes
  oynadığında da erken biter (`nightComplete`); ikisi ayırt edilemez. Bunu
  yalnız kâhin bilir, söylerse kendi rolünü açık eder.
- **Gündüz de aynı:** Şüphe kendisine döndüğünde negatif `extend` (−600 sn'ye
  kadar) ya da `advance` tartışmayı keser.
- **Düzeltme:**
  - Host müdahaleleri (`advance`, `extend`, `pause`, `kick`) herkese açık olay
    kaydına yazılsın: "Host geceyi erken bitirdi (18 sn kala)".
  - Gece `advance`'i yalnız `nightComplete` olunca ya da gece en az 10 sn
    sürdükten sonra kabul edilsin.
  - İsteğe bağlı **anlatıcı modu:** Koltuk almayan host tam yetkili olur;
    koltuk alan host'un tempo yetkileri sınırlanır.

**B-02 — VV: oyunda çıkarmak hem öldürüyor hem rolü açıklıyor.**
- **Senaryo:** Vampir host, kâhin olduğundan şüphelendiği oyuncuyu "AFK" diye
  çıkarır. Oyuncu ölür ve rolü herkese açılır (`removed`).
- Olay kayıtta görünür ama geri alınamaz.
- **Düzeltme:** Oyun sürerken çıkarma yalnız şunlara açık olsun:
  - en az 60 sn kopuk oyuncular (bkz. 3.3);
  - koltuğu olmayan bir "Etkinlik başlat" yetkilisi.

**B-03 — Çift hesap.**
- **Sorun:** Bir kişi ikinci bir tarayıcıdan misafir olarak ya da ikinci bir
  hesapla katılabilir. Sunucu yalnız üyeliğe ve sese bakıyor.
- **Etkisi:**
  - **VV:** İki koltuk, iki rolün bilgisi demek (biri vampir, biri kâhin
    olabilir).
  - **Hushle:** Rakip takımdaki ikinci hesap, kendi takımı anlatırken kartı
    görür.
  - **Poll:** Aynı soruya birden çok oy.
- **Hafifletme** (tamamen önlenemez):
  - koltuklarda "misafir" rozeti;
  - etkinlik başına "yalnız hesaplılar" ayarı;
  - Poll'da "yalnız sesli kanaldakiler" ya da "yalnız hesaplılar";
  - VV lobisinde host onayı (çıkarma zaten var).
- **İsteğe bağlı:** Aynı cihaz çerezinden (`lf_device`) iki koltuk alınınca
  yalnız host'a uyarı. KVKK açısından IP hiç gösterilmez.

**B-04 — VV: kopan oyuncunun rolü gecenin süresinden anlaşılıyor.**
- **Kural:** Gece, gece yetkisi olan herkes seçim yapınca erken biter
  (`nightComplete`).
- **X koparsa:**
  - X kâhin, doktor, avcı, vampir ya da kalkanı kalmış hayatta kalan ise gece
    her seferinde sonuna kadar sürer;
  - köylü ya da soytarı ise gece eskisi gibi erken biter.
- **Sızıntı:** Masa "X düşünce geceler uzadı" diyerek X'in yetkili olduğunu
  anlar.
- **İki vampirli oyun:** X vampirse ısırma çoğunluğu 2/2 olduğu için oyun
  boyunca hiç ısırma olmaz.
- **Düzeltme (3.3):**
  - `nightComplete` uzaktaki oyuncuları, rolü ne olursa olsun beklemez.
  - Süre dolunca ısırma çoğunluğu, sesteki yaşayan vampirlerden hesaplanır.

**B-05 — Olay sayısı yan kanalı.**
- **Sorun:** Kaydedilen her eylem tüm abonelere `revision` ile bir olay
  gönderir.
- **VV'de:** Rol gösterimi ve gece boyunca durumu yalnız gizli eylemler
  değiştirir (sürü sohbeti, gece seçimleri). Yani "şu an fısıldaşıyorlar" ve
  ne zaman fısıldaştıkları görünür. Açık mikrofondaki klavye sesi ya da kamera
  ile birleşince kişiyi işaret edebilir. `docs/VAMPIRE_VILLAGE.md` bu yan
  kanalı zaten kabul ediyor.
- **Düzeltme:**
  - Host, herkese açık projeksiyonun değişip değişmediğine bakar.
  - Değişmediyse olay yalnız etkilenen izleyicilere gider: eylemi yapan ve
    sürü.
  - Bunun için bus mesajına `audience` alanı eklenir; gateway buna göre süzer.

**B-06 — Eskimiş niyet.**
- **Hushle:** **BUST** kart kimliği taşıyor; **Bildi**, **Pas**, **Ceza** ve
  **Sonraki kart** taşımıyor.
  - Bir rakip A kartına BUST'a basarken host da **Bildi**'ye basar.
  - BUST önce işlenir: A cezalanır, yeni kart B gelir.
  - Ardından **Bildi**, hiç anlatılmamış B'ye puan verir.
  - Host ile bir moderatörün aynı anda basması da aynı sonucu verir.
- **Quiz:** `answer` soru numarası taşımıyor. N. soru için gecikmiş ya da
  yeniden denenen bir cevap `next`'ten sonra gelirse N+1'e işlenir.
- **Poll:** `vote` (`opt-1`), temizlenip yeniden açılan ankete düşer.
- **Düzeltme:** VV'deki `phaseId` gibi `cardId`, `questionIndex` ve `pollId`
  eklenir. Eşleşmeyen niyet sessizce yok sayılır.

**B-07 — Kaybederken bitirme.**
- **Hushle:** Host `end-game` ile oyunu istediği an bitirir; kazanan o anki
  skordur. Kendi takımının turundan hemen sonra, öndeyken bitirebilir.
- **Quiz:** Host öndeyken `end` diyebilir (açık soru geçersiz sayılır) ya da
  **Göster**'e erken basabilir.
- **Oturumu bitirmek** (`end` yolu): Her oyunu sonuçsuz kapatır; VV'de roller
  hiç açılmaz. Sonuç geçmişi olmadığı için iz kalmaz.
- Puan ya da sıralama tutulmadığı için bunu yapma isteği düşük.
- **Düzeltme:**
  - Hushle'da "tur eşitliği": bitirme isteği turun sonunu bekler ya da sonuç
    "erken bitti" diye işaretlenir.
  - Quiz'de "host bitirdi" etiketi.
  - Kanal başına son birkaç sonucu, bitiş nedeniyle birlikte tutan kısa bir
    geçmiş.

**B-08 — Zar.**
- **Sorun:** `roll` için bekleme süresi yok (dakikada 90'a kadar) ve geçmiş
  son 20 atışı tutuyor.
- **Etkisi:** "Kim başlar" atışında kötü sonuç, ~20 atışla görünen geçmişten
  itilebilir. "En iyi atış" da çok atanı ödüllendiriyor.
- **Düzeltme:**
  - kişi başına 2 sn bekleme;
  - "tur" modu: host turu açar, herkes bir kez atar, turun geçmişi kesilmez.

**B-09 — Yayılım çarpanı.**
- **Sorun:** Gateway her olayda her abone için oturum satırını ayrı okuyor.
- **Ölçek:** 20 kişi dakikada 90 kez zar atar, 50 kişi izlerse dakikada ~90 bin
  okuma eder.
- **Düzeltme:**
  - Gateway sürecinde `(sessionId, revision)` başına tek okuma; projeksiyon
    izleyici başına.
  - 100–200 ms'lik birleştirme (son durum kazanır).

**B-10 — SSE ve eski host.**
- **Sorun:** `stream` yolu `hostUserId`'yi bağlantı anında sabitliyor.
- **Etkisi:** Host'a özel projeksiyon yapan bir sandbox eklentisinde (ör.
  anlatıcı görünümü), host devrinden sonra eski host o görünümü almaya devam
  eder.
- Uygulama bu yolu kullanmıyor ama her üye çağırabiliyor.
- **Düzeltme:** Host her olayda tazelensin ya da yol kaldırılsın.

**B-11 … B-15 (bilgi):**
- **B-11:** Oyuna katılan "Görünmez" bir kullanıcı, kanalı gören herkese
  oyuncu listesinde adıyla görünür. Belgelenmeli ya da gizlilik kuralı
  uygulanmalı.
- **B-12:** Ses şartı bir oyun kuralı, güvenlik sınırı değil. LiveKit çökerse
  dışarıdan oynanabilir. Bilinçli bir seçim ve loglanıyor.
- **B-13:** Cevaplar AGPL depoda açık, ama zaten genel kültür soruları.
  Rekabetçi oyun için sunucu paketleri önerilmeli.
- **B-14:** Özel sorularda soruları yazan kişi varsayılan olarak quizmaster
  olsun; oynamak isterse listeye kendisi katılsın.
- **B-15:** Biten oturumların durumu (VV sürü sohbeti, Quiz cevapları) API'den
  okunamıyor ama süresiz saklanıyor. 30 gün sonra durum silinsin, özet kalsın
  (KVKK veri en azaltma).

### 2.3 Teknik olarak önlenemeyen işbirliği

Açıkça söylemek gerekirse aşağıdakileri kod engelleyemez:

| Yol | Örnek | Hafifletme |
|---|---|---|
| Ses ve DM | VV'de vampirler DM'den konuşur, ölüler ipucu verir | "Nasıl oynanır" metninde ev kuralları. Faz 2: host'un ölüleri sesli kanalda susturması (sunucuda susturma zaten var; eklentinin bunu host üzerinden istemesi gerekir) |
| Ekran paylaşımı, aynı oda | Hushle'da anlatan takımdan biri rakibin ekranına bakar | Koltuklu bir oyuncu ekran paylaşıyorsa panelde "ekran paylaşıyor" rozeti. Kartı "yalnız hakem görsün" ayarı (2.5) |
| İzleyiciden yardım | Quiz'de bir izleyici cevabı arar ve söyler | Yok. Kısa süre seçmek (10 sn) yardımı zorlaştırır |
| Aynı cihaz | İki kişi tek ekrandan oynar | Rastgele dağıtım: VV rolleri rastgele; Hushle bölmesi rastgele ama host düzenleyebilir |

### 2.4 Pazar yeri eklentileri: güven modeli

- **Neler yapamaz** (ADR-007):
  - Ağa çıkamaz: QuickJS'te ağ yok, iframe CSP'si `connect-src 'none'`. Yani
    gördüğünü dışarı sızdıramaz.
  - Başka oturumu ya da başka bir eklentinin verisini okuyamaz.
  - Hangi eylemi kimin göndereceğini değiştiremez. Politikalar, web
    uygulamasının manifestten okuduğu haliyle uygulanır.
  - Kimlik alanlarını taklit edemez; `actorFields` host'ta ezilir.
  - Saate ve rastgeleliğe istemci yön veremez.
- **Neler yapabilir:** Tam durumu sunucuda tutar ve projeksiyonu kendisi
  yazar. Bu yüzden kötü niyetli bir eklenti, tasarım gereği gizli bilgiyi
  sızdırabilir:
  - `projectState`, gizli bir "parola" eylemi gönderen kişiye (ör. yazarın
    kendisine) her şeyi verebilir;
  - ya da reducer gizli bilgiyi herkese açık bir alana kopyalayabilir.

  Host bunu engelleyemez.
- **Host'un uyguladıkları:**
  - kimlik doğrulama, üyelik ve kanal görünürlüğü;
  - eylem politikası, ses şartı ve hız sınırı;
  - boyut sınırları: 4 MiB durum, 64 KiB iframe mesajı, saniyede 10 eylem;
  - `hasProjection: false` olan eklentide uyarı.
- **Model:** Pazar yeri eklentisinde oyunun dürüstlüğü yazarına güvene bağlı.
  Platformun güvenliği (hesaplar, başka veriler, ağ) bağlı değil.
- **Öneri:**
  - "Gizli bilgi içeren oyun" etiketi yalnız doğrulanmış (verified)
    yayıncılara verilsin.
  - İnceleme listesine şu madde eklensin: projeksiyon izleyici kimliğine özel
    dal içermemeli.
  - Kurulum penceresi bu modeli tek cümleyle anlatsın.

### 2.5 Host yetkileri ve kötüye kullanım

| Oyun | Olası kötüye kullanım | Bugün görünür mü? | Öneri |
|---|---|---|---|
| VV | Geceyi ya da günü erken bitirmek, ±süre, çıkarmak, duraklatmak, sonuçsuz bitirmek | Çıkarma ve bitirme kayıtta görünür; erken bitirme görünmez | B-01, B-02; tüm müdahaleler olay kaydına |
| Hushle | Host aynı zamanda hakem: kendi takımına **Bildi**, rakibe **Ceza**, kolay kart için **Sonraki kart**; takımları istediği gibi dizmek | Doğru, pas ve ceza sayaçları açık; kimin bastığı görünmez | Puan olaylarını akış olarak göster ("Host: Bildi +1"). İsteğe bağlı **rakip hakem**: puanı rakip takımdan biri verir (klasik Tabu) |
| Quiz | Öndeyken bitirmek, erken göstermek, özel soruların cevabını bilmek | Kısmen | B-07, B-14 |
| Poll | Lehine giderken kapatmak, temizlemek | Host eylemleri denetim kaydında | İsteğe bağlı kapanış saati; sonuçları kapanana kadar gizleme |
| Dice | Geçmişi temizlemek, istatistiği sıfırlamak | Denetim kaydında | Tur modu (B-08) |
| Hepsi | Oturumu bitirmek, baştan başlatmak | `activity.end` denetim kaydında | Kısa sonuç geçmişi (B-07) |

Host eylemleri zaten denetim kaydına yazılıyor (`audit` varsayılan olarak
açık). Ama kaydı yalnız denetim kaydı yetkisi olanlar görüyor, masa görmüyor.

## 3. Kopmalar ve dayanıklılık

### 3.1 Bugün ne oluyor (koddan)

**Sinyaller ve süreler:**

| Katman | Davranış | Kaynak |
|---|---|---|
| LiveKit istemcisi | Önce **resume** dener: ICE yeniden başlar, katılımcı aynı kalır, sunucuya olay gitmez. Olmazsa **tam yeniden bağlanma** (sunucuda `left` + `joined`). 10 deneme, beklemeler: 0; 0,3; 1,2; 2,7; 4,8 sn, sonra 5×7 sn (üçüncü denemeden itibaren +0–1 sn). Toplam ~45–55 sn; sonra `Disconnected` ile vazgeçer | `livekit-client@2.19.2` `DefaultReconnectPolicy`, `RTCEngine.handleDisconnect` |
| Sayfadan ayrılma | `pagehide`, `beforeunload` ve `freeze` olaylarında `room.disconnect()` çağrılır. Temiz ayrılış olduğu için sunucu `participant_left`'i hemen görür | livekit-client `Room.ts:1112-1118` |
| LiveKit sunucusu | Sessiz kopmada ICE önce 10 sn "disconnected", 5 sn sonra "failed" olur. `participant_left` tahminen 15–30 sn sonra gelir (ölçülmeli). Oda, son kişi çıktıktan 300 sn sonra kapanır | livekit `pkg/rtc/transport.go`; `infra/livekit/livekit.yaml.template` |
| LiveKit token'ı | 10 dk geçerli; bağlıyken sunucu yeniler | `lib/livekit.ts:32` |
| Uzaklık defteri | Webhook `participant_left`'te `voice-away:{oda}:{kullanıcı}` anahtarına zamanı yazar (6 sa TTL), `joined`'de siler. Webhook yoksa saati ilk okuyan başlatır | `lib/activity-voice.ts:141-199`; `livekit/webhook/route.ts:229-260` |
| Host devri | 60 sn sonra hosting odada en uzun süredir olana geçer (önce oyuncular). 3 dk sonra (aday yoksa 60 sn) oturum terk edilmiş sayılır ve sesteki herkes bitirebilir. Karar tembel: GET, eylem ya da bitirme anında verilir; panel vakti gelince yeniden okur | `lib/activity-host.ts:53-55, 89-146` |
| Panel dürtmesi | Webhook `rosterChanged`'i yalnız **host** ayrılınca ya da dönünce yollar | `webhook/route.ts:248` |
| ws-gateway | Sunucu 30 sn'de bir ping atar; cevap gelmezse bağlantıyı bir sonraki turda keser. İstemci 60 sn mesaj almazsa bağlantıyı kendisi kapatır. Yeniden bağlanma beklemesi 0,5 sn × 2ⁿ (en çok 30 sn). 20 denemede (~7,5 dk) vazgeçer. Bağlantı kapalıyken 5 sn'de bir HTTP ile yoklar | `server.ts:28, 358-372`; `realtime-client.ts:92-94, 249-273`; `useActivitySession.ts:173-191` |
| Yeniden abonelik | Bağlantı açılınca konulara yeniden abone olur ama durumu **yeniden çekmez**; kaçan olaylar kaybolur | `realtime-client.ts:198-209` |
| Eylem gönderme | Yalnız 409 çakışmada aynı `actionId` ile yeniden dener. **Ağ hatasında yeniden denemez.** Kullanıcı tekrar basarsa yeni bir `actionId` gider | `activity-action-retry.ts:79-125`; `useActivitySession.ts:254-257` |
| Ses sağlayıcı | LiveKit vazgeçince `activeChannelId = null` olur ve otomatik dönmez. Kullanıcının seste olduğu hiçbir yere kaydedilmiyor. Sayfa her açılışta sohbet görünümüyle başlıyor | `LobbyVoiceProvider.tsx:1038-1057, 507` |

**Senaryolar:**

| Senaryo | Ses | Host yetkisi | Koltuk, rol, takım | Oyun durur mu? |
|---|---|---|---|---|
| (a) Sayfa açık, yalnız ses düşer | LiveKit ~45–55 sn yeniden dener, sonra vazgeçer. Panel açık kalır ve güncellenir; eylemler `voice_required` alır | `left`'ten 60 sn sonra devredilir | Durur; hiçbir oyun kopmayı bilmiyor | Host kopmuşsa devir gerçekleşene kadar durur: Hushle'da tamamen, Quiz'de gösterim ekranında |
| (b) İnternet 5 sn | Çoğunlukla resume; sunucu fark etmez | Değişmez | Değişmez | Hayır; o sırada yapılan tıklama "ağ hatası" verir |
| (b) 30 sn | "Reconnecting". Sessiz kopmada ~15–30 sn'de `left`, dönüşte `joined`. Aradaki eylemler `voice_required` alır | Devir olmaz (60 sn dolmaz) | Değişmez | Hushle anlatıcısıysa süre boşa gider. WS yarı açık kalırsa ekran 60 sn'ye kadar bayat kalır; o sırada yoklama da yok |
| (b) 2 dk | LiveKit vazgeçer; sese **elle** dönmek gerekir | Host ise devredilir; devir kalıcı | Değişmez | VV: gece ve oylama süreyle akar, oyuncu eylem yapamaz. Quiz: sorular kaçar, her soru süresi dolana kadar bekler. Hushle: tur(lar) boşa gider |
| (b) 10 dk | Aynısı. Ayrıca WS ~7,5 dk'da vazgeçer ve 5 sn'lik yoklamaya düşer | Odada kimse kalmadıysa oturum 60 sn'de terk edilmiş sayılır; herkes bitirebilir | Değişmez. VV'de bu arada asılmış ya da ısırılmış olabilir | Aynı |
| (c) Sayfa yenilenir | Temiz ayrılış, hemen `left`; ses geri gelmez. Sayfa sohbet görünümüyle açılır, oyuna dönmek **iki tık** ister: sesli kanal ve **Birlikte oyna** | Host'un dönmek için 60 sn'si var; sonra hosting kalıcı olarak gider | Değişmez. Durum sunucudan yeniden yüklenir, bilgi kaybı yok | Host 60 sn içinde dönmezse devir gerçekleşene kadar |
| (d) Sekme kapanır | Temiz ayrılış | 60 sn | **Süresiz** tutulur. VV: sonsuza kadar yaşayan ama oynamayan bir koltuk kalır. Quiz: her soru süresi dolana kadar bekler. WP: izleyici 12 dk sonra "uzakta" olur | Durmaz ama yavaşlar |
| (e) Telefonda uygulama arka plana geçer | Tarayıcıya bağlı (doğrulanmadı). Chrome sayfayı dondurursa `freeze` ile temiz ayrılış olur; döndüğünde kullanıcı sesten düşmüş bulur. Ses çalarken sayfa dondurulmayabilir: o zaman sesteymiş gibi görünür ama oynamaz | Seste görünürse devir **olmaz** | Değişmez | Seste görünüp oynamıyorsa ve host ise oyun takılır (Hushle'da tamamen) |
| (f) Host düşer | — | 60 sn'de devir, 3 dk'da terk edilmiş. WP'de parti host'u için ayrıca 150 sn kuralı | — | Hushle: devir gerçekleşene kadar her şey durur. Quiz: gösterimde takılır. VV: akar; yalnız duraklatılmışsa durur. Poll ve Dice: devir yok, anket açık kalır |

**Bugünkü boşluklar:**
- **D-01:** Oyunlar kopmayı bilmiyor; koltuk ve rol süresiz tutuluyor. Masada
  kimin koptuğunu yalnız ses listesi gösteriyor.
- **D-02:** Yenilemeden sonra ses de görünüm de geri gelmiyor. Host'un dönmek
  için 60 sn'si var. Devir kalıcı; hostluğu geri vermenin yolu yok.
- **D-03:** LiveKit vazgeçince bir daha denemiyor; ağ geri geldiğinde
  (`online`) ya da sekmeye dönüldüğünde bile.
- **D-04:** WS yeniden bağlanınca durum yeniden eşitlenmiyor. Yarı açık
  sokette ekran 60 sn'ye kadar bayat kalıyor.
- **D-05:** Ağ hatasında eylem kayboluyor. Kullanıcı tekrar basınca, ilk
  eylem aslında işlendiyse iki kez uygulanır (Hushle "Bildi" ×2).
- **D-06:** Webhook yalnız host için dürtüyor; başka bir oyuncu kopunca
  paneller tazelenmiyor.
- **D-07:** Hushle'da duraklatma yok. Anlatıcı düşünce tur boşa gidiyor; host
  düşünce puanlama duruyor.
- **D-08:** Quiz'de kopan aktif oyuncu her soruda erken gösterimi
  engelliyor. Host düşünce oyun gösterimde takılıyor.
- **D-09:** VV'de B-04. Ayrıca iki vampirden biri koparsa ısırma imkânsız
  oluyor.
- **D-10:** Watch Party'de iki ayrı "host yok" kuralı var: 150 sn kalp atışı
  ve 60 sn ses.
- **D-11:** Oyun sırasında sunucudan atılan ya da yasaklanan oyuncunun koltuğu
  kalıyor.
- **D-12:** VV'de seste olmayan izleyicilerin `timeout` dürtmesi reddediliyor.
  Geriye yalnız onlar kaldıysa faz ilerlemiyor (uç durum).

### 3.2 Ses sorunu: yenilemeden sonra sese dönüş

**Neden düşüyor:**
- livekit-client sayfadan çıkılırken bilerek ayrılıyor
  (`disconnectOnPageLeave`).
- Yenileme her zaman yeni bir bağlantı demek; sayfalar arasında resume yok.
- Yeni bir token gerekiyor (`POST /api/livekit/token`).

**İstemci seste olduğunu nereden bilir? Bugün hiçbir yerden.** İki kaynak
öneriyorum:

1. **`sessionStorage['lf.voice.resume.v1']`.**
   - **İçerik:** `{ serverId, channelId, channelName, at }`.
   - **Ne zaman yazılır:** Bağlantı `Connected` olunca. `at`, 5 sn'lik kalp
     atışıyla güncellenir.
   - **Neden sessionStorage:** Sekmeye özel; yenilemede kalır, sekme kapanınca
     gider. İstenen davranış tam bu.
   - **Ne zaman silinir:** Kullanıcı kendisi ayrılınca ya da kanal
     değiştirince. Ayrıca şu ayrılma nedenlerinde:
     - `DUPLICATE_IDENTITY`: başka sekme devraldı; silinmezse iki sekme
       birbirini atar;
     - `PARTICIPANT_REMOVED`: moderatör çıkardı; otomatik dönüş moderasyonu
       boşa çıkarmamalı;
     - `ROOM_DELETED`;
     - ses engeli.
   - **Sekmeyi çoğaltma:** sessionStorage'ı da kopyalar. Bu yüzden ek bir
     kilit gerekir (`navigator.locks.request('lf-voice')` ya da
     BroadcastChannel).
2. **Sunucudan ipucu.** Sekme kapanıp yeniden açılınca ya da başka bir
   cihazda da çalışır. Etkinliğin `GET` yanıtına şu eklenir:
   `viewer: { seated, voiceRequired, inVoice, awaySince, seatHeldUntil }`.
   Gereken veri defterde zaten var.

**Davranış:**
- **Varsayılan: tek tık.** Lobinin üstünde ve etkinlik panelinde bir şerit
  çıkar: "Sesten düştün. [#oyun-odası kanalına dön]". Bu tıklama, tarayıcının
  ses çalmak için istediği kullanıcı hareketini de sağlar (autoplay).
- **Otomatik dönüş** yalnız şu üç koşul birlikte sağlanınca:
  - kayıt 120 sn'den yeni;
  - gezinme türü `reload`;
  - `navigator.permissions.query({name:'microphone'})` sonucu `granted`.

  O zaman bağlanır ve mikrofon bugünkü gibi kapalı başlar. Ses çalma ilk
  tıklamaya kadar engelli olabilir; mevcut `audioBlocked` uyarısı bunu
  karşılar. Safari izni her oturumda yeniden sorabilir; o zaman tek tık
  kalır.
- **Görünüm:** `sessionStorage['lf.view.v1'] = { mode: 'activity',
  channelId }` ile yenilemeden sonra etkinliğe geri dönülür.
- **`voice_required` çıkmaz sokak olmasın:** Ses isteyen bir oyunda seste
  değilsen panelin üstünde kalıcı bir "Oynamak için sesli kanala katıl
  [Katıl]" düğmesi olur. Reddedilen eylemin yanında da aynı düğme çıkar.
- **Ağ kopmalarında LiveKit:**
  - Daha uzun bir `reconnectPolicy` (~2 dk; asansör ya da tünel için).
  - Vazgeçtikten sonra, `online` olayında ve sekme görünür olunca bir kez
    daha dener. Kayıt durduğu sürece.
- **Masaüstü (Tauri):** Aynı webview. sessionStorage pencere yenilenince
  kalır.

### 3.3 Önerilen tasarım

**Durumlar:**

| Durum | Tanım (ses isteyen oyunda) | Oyuna etkisi |
|---|---|---|
| Bağlı | Etkinliğin sesli odasında | — |
| Titreme | Odadan 10 sn'den kısa süredir uzak | Hiçbir şey; rozet yok. LiveKit resume'u ve sayfa yenileme buraya sığar |
| **Uzakta (koptu)** | En az 10 sn uzak; koltuk süresi dolmadı | Rozet ve geri sayım; sırası gelirse atlanır; oyuna göre kural |
| **Ayrıldı** | `leave` eylemi, koltuk süresinin dolması, host'un çıkarması ya da sunucudan atılma/yasaklanma | Oyunun "ayrılma" kuralı çalışır (VV: kaçtı, rol açılır; Quiz: pasif; …) |
| Bağlı ama oynamıyor (AFK) | Seste ama eylem yapmıyor | Otomatik bir şey olmaz. Oyun eylemi "kaçırdı" sayar; üst üste 2 kez kaçırana "uyuyor" rozeti, host'a çıkarma önerisi |

**Sayılar:**

| Eşik | Değer | Ne olur |
|---|---|---|
| Titreme | 10 sn'den kısa | Görünmez |
| Uzakta rozeti | 10 sn | "Bağlantı koptu · 2:50" |
| Hushle anlatıcı ya da host'u için saat duraklatma | 10 sn | Tur saati durur, kalan süre saklanır |
| En uzun duraklama | Tur başına toplam 60 sn | Sonra anlatıcılık takımdaki sıradaki oyuncuya geçer (host'sa devir zaten 60 sn'de) |
| Host devri | 60 sn (var) | Değişmez |
| Terk edilmiş oturum | 3 dk (var) | Değişmez |
| Koltuk süresi | VV 3 dk (ayar: 1–10 dk), Hushle 5 dk, Quiz 5 dk, Watch Party 10 dk; Poll ve Dice'ta yok | "Ayrıldı" kuralı çalışır |
| Host'un ek süresi | Oyuncu başına bir kez +3 dk | Fazları durdurmaz |
| İkinci kopma | Aynı tur ya da fazda | Saat durmaz |

**Diğer oyuncular ne görür:**
- **Oyuncunun satırında:** `wifi_off` simgesi, "Bağlantı koptu" yazısı ve geri
  sayım ("2:41"). Renk tek ipucu değil. Ekran okuyucuya `role="status"` ile,
  her saniye değil 30 sn'de bir duyurulur.
- **Sıra kopan oyuncudaysa üst şerit:** "Anlatıcı koptu. Saat durdu; 0:52
  içinde dönmezse sıra Ayşe'ye geçer." Host'a düğmeler: **Bekle**, **Başka
  anlatıcı**, **Turu bitir**, **+3 dk**.
- **Kopan oyuncu dönünce:** "Sesten düştün. Koltuğun 2:41 daha tutuluyor.
  [Sesli kanala dön]."

**Oyun kuralları:**

*Hushle*
- **Anlatıcı turun ortasında düşerse:**
  - 10 sn sonra saat durur.
  - 60 sn içinde dönerse saat kaldığı yerden devam eder.
  - Dönmezse takımın sesteki sıradaki oyuncusu kalan süreyle anlatır.
    Ekrandaki kart puansız atılır, yeni kart çekilir.
  - Takımda seste kimse yoksa tur puansız biter, sıra öbür takıma geçer.
- **Host düşerse:** Puanlamayı yalnız host yaptığı için saat 10 sn sonra
  durur. Devirden (60 sn) sonra yeni host **Devam** der.
- **Tahminci ya da rakip düşerse:** hiçbir şey olmaz.
- **Tur başında sıradaki anlatıcı uzaktaysa:** atlanır ama yuvası korunur;
  döndüğünde önce o anlatır.
- **5 dk sonra:** rotasyondan çıkar ve "ayrıldı" görünür. Takımın puanı
  korunur; host onu yeniden oturtabilir.

*Vampire Village*
- **Oyun durmaz;** fazlar kendi saatleriyle akar. Koltuk ve rol 3 dk tutulur.
- **Uzaktayken:**
  - Gece eylemi, süre dolunca "atla" sayılır.
  - Oyu yoktur (çekimser). Çoğunluk hesabının paydası yaşayanlar olarak
    kalır.
  - Hedef alınabilir: ısırılabilir, asılabilir.
- **Erken bitişler beklemez:** Gecenin erken bitişi (`nightComplete`) ve
  oylamanın erken kapanması uzaktaki oyuncuları beklemez. Böylece gecenin
  süresi rolü ele vermez (B-04).
- **Isırma:** Süre dolunca çoğunluk sesteki yaşayan vampirlerden hesaplanır
  (en az biri seste olmalı).
- **3 dk dolunca:** Oyuncu "köyü terk etti" sayılır (mevcut
  `eliminate(…, 'fled')`). Rolü açılır; oyu ve ona yönelik seçimler düşer.
- **Çıkarma:** Host, 60 sn'den uzun süredir uzakta olanı çıkarabilir (B-02).

*Quiz*
- **Uzaktaki oyuncu aktif kalır.** Kaçırdığı sorular "kaçırdı" sayılır ve
  serisi bozulur.
- **Erken gösterim onu beklemez.**
- **5 dk sonra pasif olur** (`leave` gibi, puanı kalır). Döndüğünde bugünkü
  `join` kuralıyla sonraki sorudan oynar.
- **Host düşerse:** Yeni bir ayar: "Otomatik ilerle: kapalı / 5 / 10 sn".
  Host 10 sn'den uzun süredir uzaktaysa, gösterimden 10 sn sonra her panelin
  `next`'i kabul edilir; sunucu host'un gerçekten uzakta olduğunu doğrular.
- **Saat durmaz.**

*Watch Party*
- **Video herkeste oynamaya devam eder;** zaman çizelgesi sunucuda.
- **İzleyici:** 10 sn'de "koptu" olur, 10 dk'da listeden düşer. Eklediği
  videolar sırada kalır.
- **Parti host'u:** Tek kural, 60 sn ses (oturum host'uyla aynı). 150 sn'lik
  kalp atışı yalnız LiveKit'e ulaşılamadığında yedek olarak kalır.

*Poll ve Dice*
- Koltuk yok; verilmiş oy kalır.
- Poll'a isteğe bağlı kapanış saati (`closesAt`, tembel kapanış). Host yoksa
  "Etkinlik başlat" yetkilileri zaten kapatabiliyor.

**"Koptu" ile "ayrıldı" farkı:**
- **Koptu** geri dönülebilir bir durum; oyunda kalıcı bir sonucu yok (Hushle
  saati hariç).
- **Ayrıldı** kesin; oyunun ayrılma kuralını çalıştırır.
- Kendi isteğiyle `leave` her zaman hemen "ayrıldı" sayılır.

### 3.4 Mekanizma

- **Sinyal: LiveKit, birincil ve tek.**
  - Bugün koltuk tutan her oyun ses istiyor. Sesli odada olmak, masada olmak
    demek.
  - Var olan webhook ve `listParticipants` yeterli; istemciye yeni bir kalp
    atışı gerekmiyor.
  - Tek değişiklik: Webhook, yalnız host için değil, koltuklu her oyuncu
    ayrılıp dönünce `presenceChanged` dürtmesi yollar.
- **ws-gateway varlığı (P2):**
  - Bir kullanıcının `activity-state:{sunucu}:{oturum}` konusuna abone olması
    "panel açık" demek.
  - Ses istemeyen bir eklenti koltuk tutmaya başlarsa bu ikincil sinyal
    olarak kullanılır.
  - Gateway her pong'da bir `HSET` yazar; istemciye iş düşmez.
- **Tembel değerlendirme,** host devriyle aynı tasarım:
  - Kural biri oturuma dokununca çalışır: GET, eylem ya da bitirme.
  - Panel en yakın vade için tek bir zamanlayıcı kurar. Bugünkü
    `nextHostCheck` genelleşir ve `nextActivityCheck` olur.
  - Vadesi gelen olaylar oturum kilidi altında, vade zamanlarıyla uygulanır
    (`at = awaySince + 10 sn`). Geç uygulansalar da sonuç aynı çıkar; Hushle'ın
    kalan süresi de dahil.
  - Zamanlayıcı servisi yok. Kimse bakmıyorsa oyun ilerlemez; bakan ilk kişi
    birikmiş bütün olayları sırayla uygular.
- **Tek kaynak:** Host devri ve varlık kararları aynı LiveKit anlık
  görüntüsünden ve aynı defterden hesaplanır.

### 3.5 Veri modeli

| Ne | Nerede | Neden |
|---|---|---|
| Ne zamandan beri uzakta | Redis'te oda başına bir HASH: `lf:{env}:voice-away:{oda}`, alan = kullanıcı, değer = ms. Bugünkü kullanıcı başına anahtarın yerini alır; 6 sa TTL, her yazmada yenilenir | Odadaki herkes tek `HGETALL` ile okunur. Veri geçici. Webhook zaten yazıyor |
| Hangi olay teslim edildi | Postgres'te `game_sessions.presence jsonb not null default '{}'`; yalnız host yazar. Örnek: `{ [userId]: { awaySince, away: true, timeout: false, extendedUntil } }`. Durumla **aynı UPDATE**'te yazılır (CAS) | Redis ile DB aynı işlemde yazılamaz; bir çökme olayın iki kez teslim edilmesine ya da kaybolmasına yol açar. Göç yalnız sütun ekler |
| Oyundaki sonuç | Eklentinin durumu, `onPresence` ile. VV: herkese açık `away` haritası. Hushle: `timer.paused` ve `pausedMs`. Quiz: `players[].away` | Kural reducer'da kalır; saf ve test edilebilir |
| Oyuncu listesi | `game_session_players`: `status = 'left'`, `leftAt` dolu. `removePlayerFromSession` zaten var ama kullanılmıyor | "Ayrıldı" kalıcıdır ve listede görünür |

### 3.6 Kötüye kullanım açısı

| Niyet | Sonuç |
|---|---|
| Oyunu bekletmek | Yalnız Hushle saati durur: tur başına en çok 60 sn; aynı turdaki ikinci kopmada durmaz. VV ve Quiz hiç beklemez |
| Saati sıfırlamak | Bitişler mutlak zaman. Saat kaldığı yerden devam eder, baştan başlamaz |
| Kaybetmemek için kaçmak | Sıralama tutulmuyor. Koltuk süresi dolunca oyuncu "ayrıldı" olur: VV'de ölü sayılır ve rolü açılır, takımın sonucu değişmez; Quiz'de puanı kalır. Host'un oyunu bitirmesi için bkz. B-07 |
| Oylamadan kaçmak | Uzaktaki oyuncu yine hedef alınabilir |
| Bilgi kazanmak | Projeksiyon değişmez. Kimin uzakta olduğu zaten ses listesinden görünüyordu. B-04 düzeltmesi de rol sızıntısını kapatır |
| Host'un ek süreyi kötüye kullanması | Oyuncu başına bir kez; fazları durdurmaz |
| Host'un dönmekte olan oyuncuyu çıkarması | Yalnız en az 60 sn uzaktaysa, ve olay kayda geçer |
| Sesli kanala girip çıkma döngüsü | Dürtmeler birleştirilir; token yolu hız sınırlı; defter yazımı ucuz |

### 3.7 Eklenti SDK yüzeyi

```ts
// manifest.catalog — bildirimsel; host saatleri ve rozetleri uygular
presence?: {
  awayAfterSeconds?: number;           // vars. 10 (5–60)
  timeoutAfterSeconds?: number | null; // vars. null (hiç); VV 180, Hushle/Quiz 300
  hostMayExtend?: boolean;             // vars. true: +180 sn, oyuncu başına bir kez
};

// GamePlugin — saf, reducer gibi; aynı nesneyi döndürmek "değişiklik yok"
onPresence?: (state: TState, event: GamePluginPresenceEvent) => TState;

interface GamePluginPresenceEvent {
  kind: 'away' | 'back' | 'timeout';
  userId: string;
  since: number; // sesli odadan çıktığı an (sunucu ms)
  at: number;    // olayın vadesi (sunucu ms); Date.now() yerine bunu kullan
}

// handleAction ctx'i — kurallar için okuma
ctx.presence: { isAway(userId: string): boolean; away(): string[] };
```

- **Neden tek kanca:** `onPlayerAway` / `onPlayerBack` / `onPlayerTimeout`
  yerine tek bir `onPresence`. `onHostChange` ile aynı biçimde ve sandbox'a
  tek bir işlem olarak taşınır.
- **Sandbox:**
  - `manifest.json` aynı `presence` bloğunu alır; `sandbox-manifest.ts`
    doğrular.
  - `server.js` `onPresence` tanımlıyorsa worker'a yeni bir `onPresence`
    işlemi eklenir.
  - Tanımlamıyorsa olay `handleAction`'a
    `{ type: 'lf:presence', kind, userId, since, at }` olarak gider.
  - Eylem yolu, `lf:` ile başlayan her istemci eylemini **400** ile
    reddeder. Böylece bu olayları yalnız host gönderebilir.
  - `ctx.presence` sandbox kapsamına JSON olarak eklenir.
- **Test aracı:** `harness.presence(userId, 'away', at)`.
- **Belgeler:** `docs/PLUGIN_SDK.md`'ye bir "Kopmalar" bölümü,
  `docs/EXTENDING.md`'ye bir örnek.

## 4. Plan

Efor: **S** = 1 güne kadar, **M** = 2–4 gün, **L** = 1–2 hafta.

| # | Öncelik | İş | Efor | Dosyalar | Test |
|---|---|---|---|---|---|
| 1 | P0 | Sese tek tıkla dönüş, görünümün geri gelmesi, panelde **Sese katıl** düğmesi | M | `app/lobby/LobbyVoiceProvider.tsx`, yeni `lib/voice-resume.ts`, `app/lobby/LobbyActivityView.tsx`, `messages/{en,tr}/lobby.json` ve `room.json` | Birim: hangi ayrılma nedeninde kayıt silinir (`DUPLICATE_IDENTITY`, `PARTICIPANT_REMOVED`). happy-dom: yenilemeden sonra şerit görünür. e2e: VV oyuncusu sayfayı yeniler, tek tıkla döner, oyu kabul edilir |
| 2 | P0 | Durumu yeniden çek: WS yeniden açılınca, `online` olayında ve sekme görünür olunca | S | `lib/realtime-client.ts` (open olayı), `app/room/useActivitySession.ts` | Sahte WebSocket: kapanır, açılır, GET çağrılır |
| 3 | P0 | Ağ hatasında ve `503 retryable`'da aynı `actionId` ile ~8 sn boyunca yeniden dene | S | `lib/activity-action-retry.ts`, `useActivitySession.ts` | Birim: TypeError → yeniden deneme → duplicate → durum yeniden okunur |
| 4 | P0 | Eskimiş niyet koruması: Hushle `cardId` (Bildi/Pas/Ceza/Sonraki kart), Quiz `questionIndex`, Poll `pollId` | M | `plugins/hushle/src/actions.ts`, `ui/playing.tsx`; `plugins/quiz/src/actions.ts`, `ui/AnswerGrid.tsx`; `plugins/poll/src/index.ts`, `renderClient.tsx`; belgeler | Reducer: eski kimlik yok sayılır. BUST ile Bildi yarışı tek olay olarak işlenir |
| 5 | P0 | Webhook dürtmesi koltuklu her oyuncu için (`presenceChanged`) | S | `app/api/livekit/webhook/route.ts` | Webhook testi: host olmayan bir oyuncu ayrılınca olay yayınlanır |
| 6 | P1 | Varlık modeli (host): saf karar ve kilit altında uygulama, HASH defter, `game_sessions.presence` göçü, GET'te `presence` ve `viewer`, `nextActivityCheck`, `lf:` reddi, +3 dk | L | yeni `lib/activity-presence.ts`; `lib/activity-voice.ts`, `lib/activity-host.ts`, `lib/activity-host-view.ts`; `actions/route.ts`, `[sessionId]/route.ts`, `end/route.ts`; `packages/db/src/schema.ts`, `queries/gameSessions.ts`, `drizzle/NNNN_activity_presence.sql` | Karar tablosu testleri. Aynı anda gelen iki GET'te olay bir kez teslim edilir. Olaylar vade zamanıyla uygulanır. `lf:` → 400. e2e: 4 tarayıcı, `context.setOffline` ile 5, 30 ve 120 sn |
| 7 | P1 | SDK: `catalog.presence`, `onPresence`, `ctx.presence`; sandbox eşlemesi; test aracı | M | `packages/plugin-sdk/src/index.ts`, `testing.ts`; `apps/web/lib/sandbox-manifest.ts`, `plugin-worker-client.ts`; `apps/plugin-worker/src/sandbox-core.mjs`; `docs/PLUGIN_SDK.md` | Sandbox'ta `lf:presence` geçişi; manifest doğrulaması |
| 8 | P1 | Oyun kuralları. VV: 3 dk, çekimser oy, sesteki vampirlerle çoğunluk, `nightComplete` uzaktakini beklemez. Hushle: duraklat, devret, atla. Quiz: erken gösterim, 5 dk, otomatik ilerle. WP: tek host kuralı | L (oyun başına M) | `plugins/*/src/*`, locales | Reducer ve projeksiyon testleri. B-04 regresyon testi: gecenin süresi rolden bağımsız |
| 9 | P1 | UI kitine `PresenceBadge` ve geri sayım; her panelde kullanımı | M | `packages/plugin-sdk/src/ui/*`, panel dosyaları | Erişilebilirlik (metin + simge); açık ve koyu tema |
| 10 | P1 | VV host müdahaleleri olay kaydında; gece `advance`'ine sınır; oyunda çıkarma yalnız uzaktaki oyuncuya ya da moderatöre | M | `plugins/vampire-village/src/reducer.ts`, `state.ts`, `ui/*`, locales | Reducer: kayıt girdileri; erken `advance` reddedilir |
| 11 | P1 | Gateway'de olay başına tek okuma ve birleştirme | S–M | `apps/ws-gateway/src/server.ts` | N soket için tek `getGameSessionById` |
| 12 | P1 | Zar: bekleme süresi ve tur modu. Poll: seçmen kapsamı ve sonuçları kapanana kadar gizleme | M | `plugins/dice-bot`, `plugins/poll` | Reducer testleri |
| 13 | P2 | Bus `audience`: değişiklik yalnız gizliyse hedefli olay (B-05) | M | `actions/route.ts`, `lib/activity-bus.ts`, `ws-gateway/src/server.ts`, core'da yardımcı | Gece sürü sohbeti olunca köylüye olay gitmez |
| 14 | P2 | Sonuç geçmişi, Hushle tur eşitliği, "erken bitti" etiketi (B-07) | M | yeni tablo ve göç; eklentiler | — |
| 15 | P2 | Çift hesap hafifletmeleri: misafir rozeti, "yalnız hesaplılar", aynı cihaz uyarısı | M | lobi ve eklentiler | — |
| 16 | P2 | SSE yolunu düzelt ya da kaldır (B-10); "hostluğu devret" eylemi; biten oturumları temizle (B-15); WS'de `visibilitychange` ile yeniden bağlan | Her biri S | ilgili dosyalar | — |
| 17 | P2 | VV'de ölüleri sesli kanalda susturma (eklenti host'tan ister): önce ayrı bir tasarım | L | — | — |

Belgede güncel olmayan bir bilgi: `docs/VAMPIRE_VILLAGE.md` hâlâ "adres başına
30 eylem/dk" diyor. Doğrusu oturumda kullanıcı başına 90 eylem/dk; adres
başına 600 yalnız yedek.

## Doğrulanamayanlar, ölçülecekler

- **LiveKit'in sessiz kopmadaki süresi:** Sunucu `participant_left`'i kaç
  saniyede gönderiyor? Tahmin ~15–30 sn.
  - Ölçüm: e2e'de `context.setOffline(true)` ile 5, 30, 120 ve 600 sn kesinti;
    webhook zamanları loglanır.
- **Telefonda arka plan:** iOS Safari ve Android Chrome'da arka planda WebRTC
  sesi sürüyor mu, `freeze` olayı ne zaman geliyor?
- **Mikrofon izni:** Safari ve Firefox, sayfa yenilenince izni yeniden soruyor
  mu?
- **Tauri:** WebView2 ve WKWebView küçültülünce zamanlayıcıları ne kadar
  yavaşlatıyor?

## Kaynaklar

- **Kod** (commit `aad7725`):
  - `apps/web/app/api/servers/[id]/activities/**`
  - `apps/web/lib/activity-{voice,host,host-view,action-retry}.ts`
  - `apps/web/lib/action-idempotency.ts`
  - `apps/web/app/api/livekit/webhook/route.ts`
  - `packages/core/src/activity-projection.ts`
  - `apps/ws-gateway/src/server.ts`
  - `apps/web/lib/realtime-client.ts`
  - `apps/web/app/room/useActivitySession.ts`
  - `apps/web/app/lobby/{LobbyActivityView,LobbyVoiceProvider,LobbyAppsSection}.tsx`
  - `plugins/*/src`
- **LiveKit:**
  - Bağlantı güvenilirliği: <https://docs.livekit.io/home/client/connect>
  - ICE zaman aşımları:
    <https://github.com/livekit/livekit/blob/master/pkg/rtc/transport.go>
  - İstemcinin yeniden bağlanma davranışı (`livekit-client` 2.19.2):
    `src/room/DefaultReconnectPolicy.ts`, `src/room/RTCEngine.ts`,
    `src/room/Room.ts`
- **İlgili belgeler:**
  - `docs/ACTIVITIES.md`
  - `docs/PLUGIN_SDK.md` ("Voice, hosting and play again")
  - `docs/HUSHLE.md`, `docs/QUIZ.md`, `docs/VAMPIRE_VILLAGE.md`,
    `docs/WATCH_PARTY.md`
  - ADR-007 (`docs/ARCHITECTURE_DECISIONS.md`)
