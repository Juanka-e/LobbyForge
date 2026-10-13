# Güvenlik İncelemesi — 2026-10-13

Kapsam: `main` @ `7798270` (PR #105 dahil): web uygulaması ve API rotaları,
ws-gateway, plugin worker sandbox'ı, etkinlikler ve eklenti etkileri
(zamanlayıcı, depo, uygulama mesajı), botlar ve webhook'lar, pazar yeri
kurulumu ve çerçeve (aşama 1–3), resmi hub, Tauri masaüstü, Docker / nginx /
coturn / LiveKit, `install.sh`, `lfctl` ve CI.

Önceki incelemeden (2026-10-03, [SECURITY_REVIEW_2026-10.md](SECURITY_REVIEW_2026-10.md))
bu yana gelenler özellikle incelendi:

- Bot API v2 ve olay akışı;
- pazar yeri sandbox'ı ve eklenti kilidini açma aşamaları 1–3;
- CAPTCHA ve e-posta doğrulama;
- sohbet anketleri;
- hesap dili;
- kopma dayanıklılığı (P0).

**Yöntem:**

- **Altı salt-okunur inceleyici:**
  - kimlik doğrulama;
  - yetkilendirme ve topluluk;
  - botlar;
  - etkinlikler ve gerçek zamanlı akış;
  - pazar yeri ve sandbox;
  - yükleme, altyapı, masaüstü, CI ve hub.
- Hepsi `security-review` becerisinin kuralıyla çalıştı. Saldırgan girdisi
  uçtan uca izlendi; yalnızca **yüksek güvenli** bulgular raporlandı.
- Emin olunamayanlar "doğrulanmalı" diye ayrıldı.
- Önceki raporun §12'de düzeltildi denen maddeleri yeniden kontrol edildi.
  Hiçbiri geri gelmemiş.
- Her bulgu düzeltilirken koda karşı yeniden doğrulandı.

## 1. Karar

**Kritik ya da yüksek önemde açık yok.** Bulgular çoğunlukla:

- servis dışı bırakma (DoS);
- yetki sınırlarında ince boşluklar;
- sertleştirme.

İnceleme bir de **işlevsel bir hata** çıkardı: giriş yapan kullanıcı bir
saat sonra oturumdan düşüyordu (§3). O da düzeltildi.

| Önem | Sayı | Bulgular |
|---|---|---|
| Kritik | 0 | — |
| Yüksek | 0 | — |
| Orta | 7 | BOT-001 (= AUTHZ-007), BOT-002, BOT-003, PLUG-001, PLUG-002, FILE-001, AUTHZ-008 |
| Düşük | 11 | BOT-004, PLUG-003, PLUG-004, AUTHZ-009, AUTHZ-010, ACT-001, ACT-002, AUTH-001 (= INFRA-V-02), DESK-V-01, FILE-V-01, HUB-V-01 |

## 2. Bulgular

| ID | Önem | Bulgu | Düzeltme |
|---|---|---|---|
| BOT-001 / AUTHZ-007 | Orta | "Topluluğu yönet" yetkisi olup "kanalları yönet" yetkisi olmayan biri, gizli (rolle kapalı) bir kanala erişimi olan botun token'ını yenileyip o kanalı okuyabiliyor ve oraya yazabiliyor | #112 |
| BOT-002 | Orta | Sızan bir token yenilense ya da iptal edilse bile saldırganın kaydettiği olay adresi çalışmaya devam ediyor; senkron etkileşim cevabıyla bot adına yazabiliyor | #112 |
| BOT-003 | Orta (resmi hub) | Bot olay teslim kuyruğunda bot başına adalet yok; yavaş ama başarılı cevap veren adresler diğer kiracıların teslimlerini düşürtüyor | #112 |
| PLUG-001 | Orta | İnceleme anında paket sınırsız açılıyor (gzip bombası); web süreci bellek yüzünden düşebiliyor | #112 |
| PLUG-002 | Orta | Herkese açık eklenti dosya rotası her istekte paketi yeniden doğruluyor ve dosyayı baştan sona belleğe okuyor; hız sınırı yok | #112 |
| FILE-001 | Orta | Misafir hesaplar (IP başına saatte 10) her biri ~14 MiB resim saklayabiliyor; kurulum geneli üst sınır yok; disk dolabiliyor | #112 |
| AUTHZ-008 | Orta | Üyeler her mesaja ~1 MB'a kadar keyfi `metadata` ekleyebiliyor (depo, bant genişliği, bellek DoS) | #112 |
| BOT-004 | Düşük | Olay adresi kaydında çözümleyici hatası iç IP ve ana bilgisayar adlarını yansıtıyor | #112 |
| PLUG-003 | Düşük | Tar ön taraması GNU tar'dan farklı sınırlar okuyabiliyor (sağlama toplamı yok, gevşek sayı ayrıştırma) | #112 |
| PLUG-004 | Düşük | "Çerçevenin ağı yok" iddiası CSP ile sağlanamıyor (WebRTC kapsam dışı) | #112 |
| AUTHZ-009 | Düşük | Engellemeler canlı sohbette uygulanmıyor (bildirimler dahil) | #112 |
| AUTHZ-010 | Düşük | Denetim kaydı davet kodlarını ve gizli kanal ayrıntılarını denetim kaydı yetkisi olanlara gösteriyor | #112 |
| ACT-001 | Düşük | Kullanılmayan SSE akışı, iptal edilmiş oturumu ilk 30 sn kabul ediyor | #112 |
| ACT-002 | Düşük | Bir eylem, vadesi gelmiş bir zamanlayıcının önüne geçebiliyor | #112 |
| AUTH-001 / INFRA-V-02 | Düşük | Geliştirme stack'i herkesin bildiği oturum sırrıyla tüm arayüzlerde açılıyor; uygulama yer tutucu sırları kabul ediyor | #112 |
| DESK-V-01 | Düşük | Masaüstü pencere, bağlanılan kurulumun dışına (her adrese) götürülebiliyor | #112 |
| FILE-V-01 | Düşük | GIF doğrulaması yalnız mantıksal ekran boyutuna bakıyor; büyük bir kare tarayıcıyı kilitleyebilir | #112 |
| HUB-V-01 | Düşük | Eklenti dosyaları `Vary`'yi yok sayan bir CDN'de (Cloudflare) uygulamanın kendi kökeninde önbelleğe girebilir | #112 |

**"Doğrulanmalı" listesinden düzeltilenler:**

- **Yetkilendirme:**
  - Rol silme hatası gizli kanalların adını veriyordu.
  - `@everyone`'ın sırası değiştirilebiliyordu.
  - Sohbet aboneliği mesaj geçmişi yetkisi istemiyordu.
  - Ortak sunucu olmadan DM açılabiliyordu; bilinmeyen kullanıcı 500 dönüyordu.
  - Yazıyor göstergesi engellemelere ve gizliliğe bakmıyordu.
  - Susturulmuş biri moderasyon yapabiliyordu.
- **Etkinlikler:**
  - Susturulmuş biri etkinliğe katılabiliyordu.
  - Kaldırılan uygulamanın oturumları sürüyordu.
  - Uygulama mesajı sınırı oturum başınaydı.
  - Zamanlayıcı birikmesi artış yaratıyordu.
  - Panel takılı vadeler yüzünden sürekli yeniden okuyordu.
  - Gizli kanala uygulama mesajı gönderilebiliyordu.
- **Botlar:** Yeniden denemeler yetkiyi yeniden kontrol etmiyordu; DNS iş parçacığı havuzu tıkanabiliyordu.
- **Eklentiler:**
  - Resmî eklenti adlarıyla pazar yeri paketi kurulabiliyordu.
  - İnceleme onayı sürüme bağlı değildi.
  - Manifest okuma sınırı sonradan uygulanıyordu.
- **Kimlik doğrulama:** Google giriş durumu çerezi `__Host-` önekini almadı; profil adı kontrol karakterlerini kabul ediyordu.
- **Masaüstü:** Giriş devri `'*'` hedefine mesaj gönderiyordu.

## 3. İşlevsel hata: oturum bir saatte bitiyordu

Oturum çerezi bir saat geçerliydi ve geçerli bir çerezi hiçbir şey
yenilemiyordu. `POST /api/auth/guest` yalnızca çerez zaten yokken
çağrılıyordu.

Sonuç olarak giriş yapan kullanıcı, ne kadar etkin olursa olsun, bir saat
sonra oturumdan düşüyordu. Misafir de kimliğini kaybediyordu.

Düzeltme (#108): **kayan oturum.**

- Çerez istek gelmeden 7 gün geçerli.
- Her API isteği (iptal kontrolünden sonra) ve her sayfa yüklemesi,
  ömrünün yarısı geçmiş geçerli bir çerezi aynı oturum kimliği ve
  `auth_time` ile yeniden imzalıyor.
- 30 günlük kesin ömür ve sunucu tarafı oturum iptali değişmedi.

## 4. Bilerek bırakılanlar

- **Bilinçli davranış:**
  - **Bot token'ları veren kişinin yetki kaybından sonra da geçerli kalıyor.**
    Discord'da da böyle; belgelendi.
  - **`member_leave.reason` (atma/ban), üye okuma yetkisi olan botlara gidiyor.**
    Belgelendi.
- **Dağıtım ayarına bağlı:**
  - **`LOBBYFORGE_TRUSTED_PROXY=cloudflare`:** Cloudflare arkasında değilken
    istemci kendi hız sınırı anahtarını seçebiliyor. Doctor bunu anlatıyor
    (önceki AUTH-V-01).
  - **Resmi hub'ın üst alan adının güvenilmeyen kardeş alt alan adları varsa**
    `lf_guest` çerezine de `__Host-` öneki gerekir. Bu, herkesin oturumunu
    kapatan bir değişiklik olduğu için ayrı planlanacak.
  - **IPv6:** Varsayılan Docker'da IPv6 istemcileri köprü ağ geçidi adresiyle
    görünebilir ve hız sınırlarını paylaşır. Doctor uyarısı ve dağıtım belgesi
    eklendi (#112); kalıcı çözüm, uç ağda IPv6'yı açmak.
- **Önceki incelemeden açık kalanlar:**
  - plugin worker'ın aynı UID ile çalışması (ADR-001);
  - `style-src 'unsafe-inline'`;
  - `braces` güvenlik bildirimi. Yalnız ESLint zincirinde, production imajında
    yok ve yaması yok.

## 5. Kontrol edilen ve sağlam bulunanlar (özet)

Her inceleyicinin "sağlam" listesi ayrıntılıdır; öne çıkanlar:

- **Oturum çerezi ve CSRF:**
  - HMAC, sabit zamanlı karşılaştırma.
  - Her girişte yeni oturum kimliği.
  - İptal kontrolü API'de, sayfalarda ve gateway'de.
  - Her değiştirici istekte köken denetimi.
- **Şifreler, sıfırlama ve doğrulama:**
  - Şifreler scrypt ile saklanıyor.
  - Hesap kilidi atomik.
  - Sıfırlama ve doğrulama belirteçleri 256 bit; tüketme tek bir koşullu UPDATE ile yapılıyor.
  - OAuth yönlendirmesi temizleniyor.
- **Yetkilendirme:**
  - Rol yükseltme kuralları ve moderasyon hiyerarşisi uygulanıyor.
  - Sunucular arası IDOR yok.
  - İstemci sunucuya ait `metadata` anahtarlarını taklit edemiyor.
  - `dangerouslySetInnerHTML` kullanılmıyor.
- **Botlar:**
  - Token 256 bit, karma ile saklanıyor.
  - Kanal erişimi tek kuralda.
  - Gateway içeriği veritabanından yeniden yüklüyor.
  - SSRF engelleri (IP sabitleme, tüm özel aralıklar, yönlendirme yok) yerinde.
  - İmza HMAC; webhook token'ları karma ile saklanıyor.
- **Etkinlikler:**
  - İstemci sistem eylemi ve etki gönderemiyor.
  - Etkiler izin ve sınırla doğrulanıyor.
  - Depo anahtar alanı sunucu tarafından belirleniyor.
  - Gizli durum her yolda izleyici başına projekte ediliyor.
  - LiveKit token'ı en dar yetkiyle veriliyor.
- **Pazar yeri:**
  - Onay istenenle birebir eşleşmeli.
  - Tarayıcı çerçevesi kendi kökeni dışına çıkamıyor (kaçış yok).
  - Worker RPC'si sabit zamanlı token ve özet (digest) ile korunuyor.
  - Dış arayüzün kökeni uygulamanınkinden farklı olmak zorunda.
- **Altyapı:**
  - Production compose iç servisleri yayınlamıyor.
  - Güncelleme Ed25519 imzalı; sürüm düşürme engelli.
  - Yedekler 0600.
  - CI'da aksiyonlar SHA ile sabitli; enjeksiyon yok.
  - Tauri IPC uzak sayfalardan erişilemiyor.

## 6. Düzeltme durumu

Bulguların hepsi düzeltildi ve `main`'e birleşti. Her alanın düzeltmesi kendi
commit'inde; testleri ve ayrıntıları özgün PR'larda duruyor (#107, #109, #110,
#111 ve `fix/sec-infra`). Tek bir CI turundan geçmeleri için #112'de
birleştirildiler.

| PR | Kapsam | Durum |
|---|---|---|
| #106 | Bağımlılıklar: Next 16.4, ioredis 6, TypeScript 6; `middleware.ts` → `proxy.ts`. Next 16.4'ün katı rota denetimi gerçek bir hata buldu: `/admin` ve bilinmeyen alt adresler doğrudan açılınca 404 veriyordu. ioredis 6'nın üstel yeniden bağlanma beklemesi, Redis kapalıyken komutları ~70 sn bekletiyordu; eski bekleme geri kondu | birleşti |
| #108 | Kayan oturum (§3), Google giriş durum çerezi (`__Host-`), profil adında kontrol karakterleri, Hushle `set-explainer` niyet anahtarı, ses yeniden bağlanma sınırı | birleşti |
| #112 | Alan 2–6'nın düzeltmeleri: pazar yeri ve sandbox, etkinlikler ve eklenti etkileri, botlar ve webhook'lar, yetkilendirme ve gizlilik, yükleme, altyapı ve masaüstü | birleşti (20/20 CI) |

**Yükseltme notu:** Yayımlanmış bir yer tutucu oturum sırrıyla çalışan kurulum
artık başlamaz (`requireSessionSecret`). Gerçek bir sır gerekir; sırrı
değiştirmek herkesin oturumunu kapatır.
