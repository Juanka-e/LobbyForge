# E-posta gönderimi ve doğrulama araştırması — 2026-10-04

Soru: E-posta doğrulaması için ne yapabiliriz? Ücretsiz servisleri
araştıralım mı? Self-host edenlere ne önerelim? Kendi projemiz (resmî hub)
için ucuz olan AWS'nin servisi miydi?

## Karar

**E-posta doğrulaması eklenmeli. Ama instance ayarı olmalı ve varsayılan
olarak kapalı başlamalı.** E-posta yapılandırmamış bir kurulum bugünkü gibi
çalışmaya devam etmeli.

- **Taşıma:** Tek bir genel SMTP aktarıcısı (nodemailer). Her sağlayıcı SMTP
  veriyor. Kendi posta sunucusu olan da aynı ayarlarla bağlanıyor. HTTP API
  adaptörleri (SES API, Resend API) v1'de gereksiz.
- **Self-host edenler:** Kendi posta sunucusunu kurmasın, bir relay'e (SMTP
  aktarma servisi) bağlansın. Küçük bir topluluğa (<1.000 e-posta/ay) yetecek
  ücretsiz katmanlar var: Brevo, SMTP2GO, Resend, Mailjet.
- **Resmî hub:** Amazon SES (Frankfurt, `eu-central-1`), SMTP üzerinden.
  Yedek seçenek Scaleway TEM. Sağlayıcı değiştirmek yalnızca ayar değişikliği.
- **Akış:** Tek e-postada hem 6 haneli kod hem link.
  - Kod; masaüstü uygulaması ve e-postayı başka cihazda açanlar için.
  - Link GET'te tüketilmez. Onay sayfasındaki düğmeyle (POST) tüketilir,
    çünkü güvenlik tarayıcıları linkleri kendiliğinden açıyor.
- **Doğrulanmamış hesap:** Giriş yapabilir ve okuyabilir. `required` modunda
  mesaj, ses, sunucu/davet oluşturma, dosya yükleme ve bot oluşturma kapalı.
- **Aynı altyapı** şifre sıfırlama ve e-posta değiştirmeye de hizmet eder.

**Sahibin sorularına kısa cevaplar:**
- *"E-posta doğrulaması için ne yapabiliriz?"* Aşağıdaki tasarım. Tek
  geliştiriciyle ~2,5–3,5 hafta.
- *"Ücretsiz servisleri araştıralım mı? Self-host edenler için?"* Araştırıldı.
  Ama LobbyForge hiçbir sağlayıcıya bağlanmamalı. Self-hoster SMTP bilgilerini
  girer. Biz dokümanda hazır ayarları ve ücretsiz katman listesini veririz.
- *"Bizim için ucuz olan AWS'ninki miydi?"* Evet. SES liste fiyatında hâlâ en
  ucuz büyük sağlayıcı: 1.000 e-posta 0,10 $. Ama dört pürüzü var:
  1. 21 Temmuz 2026'dan beri yeni hesaplar 0,16 $'lık Essentials planıyla
     başlıyor. Elle à la carte'a dönmek gerekiyor.
  2. Yeni AWS hesaplarına aylık ücretsiz SES kotası verilmiyor. Onun yerine
     6 ay geçerli 100–200 $ kredi var.
  3. Hesap sandbox'ta başlıyor. Üretim erişimi başvuru ve inceleme istiyor.
  4. Bounce ve şikâyetleri işlemek zorunlu.

  Bizim hacmimizde SES ile rakipleri arasındaki fark ayda birkaç dolar. Asıl
  maliyet kurulum ve bakım.

## Bugünkü durum

**LobbyForge bugün hiç e-posta göndermiyor.**
- Kodda nodemailer, SMTP ya da başka bir e-posta istemcisi yok.
- Şifre sıfırlama yok. `POST /api/auth/password` yalnızca oturum açıkken
  şifre değiştiriyor. Giriş sayfasındaki "Forgot password?" yalnızca tasarımda
  ayrılmış bir yer (`apps/web/app/login/_official/PasswordField.tsx`).
- `infra/docker/docker-compose.dev.yml` içinde mailpit var (`full` profili;
  SMTP `19525`, arayüz `19526`). Ama ona bağlanan servis yok.
- `projectdetails/19_OBSERVABILITY_DOCTOR_CAPACITY.md` e-postayı "isteğe bağlı
  SMTP" olarak planlamış. `25_TESTING_STRATEGY.md` testlerde SMTP'nin her
  zaman mock'lanmasını istiyor.

**Hesaplar:**
- `users` tablosunda `email_verified` benzeri bir sütun yok. `email` benzersiz
  ve boş olabiliyor (misafirlerde boş).
- Yalnızca `user_identity_links.email_verified` var. O da Google'ın beyanı.
- Kayıt (`apps/web/app/api/auth/register/route.ts`):
  - e-postayı küçük harfe çevirip benzersizliğini kontrol ediyor;
  - hesabı açıyor ve hemen oturum çerezi veriyor;
  - resmî hub'da da (`registerOfficialAccount`) aynısını yapıyor.
  Doğrulama adımı yok.
- Adres kayıtlıysa 409 ve "An account with this email already exists."
  dönüyor. Bu, hesabın var olup olmadığını sızdırıyor (enumeration).
- Google girişi e-postaya bakarak mevcut bir hesaba bağlanmıyor; yeni bir
  satır ve kimlik bağlantısı açıyor. Bu iyi: doğrulanmamış bir yerel e-posta
  üzerinden hesap ele geçirilemiyor. İleride e-posta eşleştirmesi eklenirse
  yalnızca doğrulanmış adreslerle yapılmalı.

**Hazır parçalar:**
- Linkler için güvenilir origin: `LOBBYFORGE_APP_ORIGIN` /
  `NEXT_PUBLIC_BASE_URL`. OWASP'a göre link `Host` başlığından üretilmemeli.
- `docs/CAPTCHA.md` §3.3'teki AES-256-GCM gizli anahtar düzeni.
- Redis, `withApiSecurity` hız sınırları, `auth-throttle.ts`,
  `revokeOtherSessions`, `lib/doctor.ts`.
- Son migration 0044. CAPTCHA 0045'i kullanıyor; e-posta 0046 ve sonrası olur.

**CAPTCHA araştırmasıyla bağlantı:** O rapor, captcha'nın bot kayıtlarını tek
başına durduramayacağını, asıl eksik kapının e-posta doğrulaması olduğunu
söylüyor. E-posta doğrulaması botun maliyetini artırır. Ama tek kullanımlık
adreslerle aşılabilir. Bu yüzden bir tek kullanımlık alan adı listesi de
öneriliyor.

## Sağlayıcılar

### Ücretsiz katman ve fiyat

Rakamlar 2026-10-04'te sağlayıcının kendi sayfasından alındı. **†** işareti:
birinci taraf sayfadan doğrudan okunamadı, üçüncü taraf kaynaktan geliyor.

| Sağlayıcı | Ücretsiz katman | Ücretli |
|---|---|---|
| Amazon SES | Kalıcı ücretsiz kota yok. Yeni AWS hesabına 100 $ + görevlerle 100 $'a kadar kredi, 6 ay geçerli | À la carte 0,10 $/1.000. Yeni hesap varsayılanı Essentials 0,16 $/1.000. Ek dosya 0,12 $/GB |
| Resend | Ayda 3.000, günde en fazla 100, 3 alan adı | Pro: 20 $ → 50k, 35 $ → 100k; aşım 0,90 $/1.000. Scale: 650 $ → 1M |
| Brevo | Günde 300 (kampanya + transactional toplam), kart yok | Starter 9 $/ay'dan (7 €) başlıyor |
| Mailjet | Ayda 6.000, günde 200; e-postada Mailjet logosu | Essential 19 $, Premium 29 $ (15k/ay) |
| Mailgun | Günde 100, 1 alan adı, 1 günlük log | Basic 15 $ → 10k (aşım 1,80 $/1.000); Foundation 35 $ → 50k; Scale 90 $ → 100k |
| Postmark | Ayda 100 (deneme amaçlı) | 10k/ay: Basic 15 $, Pro 16,50 $, Platform 18 $; aşım 1,80 / 1,30 / 1,20 $/1.000 |
| SMTP2GO | Ayda 1.000, günde 200† | Starter 10 $ → 10k; Professional 75 $ → 100k |
| MailerSend | Ayda 500, günde 100 API isteği; kredi kartı zorunlu | Hobby 5,60 $ → 5k; aşım 1,50 $/1.000 |
| Twilio SendGrid | **Yok.** Mayıs 2025'te duyuruldu, 60 günlük geçişle Temmuz 2025 sonunda kalktı. Yeni hesaba 60 gün, günde 100 deneme† | Email API 19,95 $ → 50k† |
| Scaleway TEM | Ayda 300 (organizasyon başına) | 0,25 €/1.000. Scale planı: 80 € → 100k, sonra 0,20 €/1.000, ayrık IP, %99,9 SLA |
| Zoho ZeptoMail | İlk kredi (10.000 e-posta) ücretsiz, 6 ay geçerli | Kredi (10k e-posta) 2,50 $†. Yeni kayıtlar için fiyat 1 Temmuz 2026'da değişti; yeni rakam doğrulanamadı |
| Azure Communication Services | Yok | E-posta başına 0,00025 $ (= 1.000 başına 0,25 $) + MB başına 0,00012 $ |
| Cloudflare Email Service (beta) | Ücretsiz planda yalnızca hesapta doğrulanmış adreslere | Workers Paid (5 $/ay) içinde ayda 3.000, sonra 0,35 $/1.000 |
| Gmail (kişisel) | Günde 500 e-posta, mesaj başına 500 alıcı | — |
| Google Workspace | — | Kullanıcı başına günde 2.000 (deneme hesabında 500) |

### Teknik ve uyum

| Sağlayıcı | SMTP portları / API | Veri yeri | Başlangıç engeli | Self-hoster için |
|---|---|---|---|---|
| SES | 25, 587, 2587 (STARTTLS); 465, 2465 (TLS); API v2 | Bölge seçiliyor; AB bölgeleri var | Sandbox, üretim başvurusu, bounce/şikâyet yapılandırması zorunlu (aşağıda) | Zor: AWS hesabı, IAM, bölge, sandbox |
| Resend | 25, 465, 587, 2465, 2587; API | ABD, İrlanda, São Paulo, Tokyo | Alan adı doğrulama | Kolay |
| Brevo | 587, 465, 2525; API | AB (Fransa, Almanya)† | Gönderim için hesap onayı bekleniyor | Kolay |
| Mailjet | SMTP; API | AB (Frankfurt, Belçika) | Alan adı doğrulama | Kolay; logo var |
| Mailgun | 25, 465, 587, 2525; API | ABD veya AB | Alan adı doğrulama | Orta |
| Postmark | 25, 587, 2525 (465 yok); API | Yalnızca ABD (Chicago + AWS) | Hesap onayı | Ücretsiz katmanı pratikte yok |
| SMTP2GO | 2525 (ana), 25, 587, 8025, 80; TLS: 465, 8465, 443 | AB veri merkezi seçeneği (Amsterdam) | Alan adı doğrulanana kadar saatte 25† | Kolay |
| MailerSend | SMTP; API | AB (Google, Belçika)† | Kredi kartı | Orta |
| SendGrid | SMTP; API | ABD | Ücretli plan şart | Önerilmez |
| Scaleway TEM | 25, 587, 2587, 465, 2465; API | AB (Fransız sağlayıcı) | Yeni hesapta varsayılan kota ayda 10.000†; ödeme ve kimlik doğrulaması | Orta |
| ZeptoMail | SMTP; API | ABD, AB, Hindistan, Avustralya, Japonya, Çin | Hesap doğrulama | Orta |
| Azure ACS | API; SMTP† | Azure bölgesi | Özel alan adında başlangıç sınırı dakikada 30, saatte 100. Artış için hata oranı <%1 ve 72 saate kadar inceleme. Azure'un verdiği alan adında dakikada 5, saatte 10 (artırılamaz) | Zor |
| Cloudflare | REST API, Workers binding, SMTP yalnızca 465 (implicit TLS) | Cloudflare | Yeni hesapta "temkinli" günlük kota; alan adının Cloudflare'da olması gerekiyor gibi | Alan adı Cloudflare'daysa kolay |
| Gmail (kişisel) | SMTP, uygulama şifresiyle (2 adımlı doğrulama şart) | Google | Gönderen adres Gmail adresi; iş/okul hesaplarında uygulama şifresi yok | Yalnızca test ya da çok küçük, kapalı gruplar |

**Teslim edilebilirlik (deliverability):** Ölçmedik. Genel kanı şu: Postmark
transactional e-postada en iyi bilinen; SES, Mailgun ve Resend iyi.
Ücretsiz katmanlar paylaşılan IP kullanıyor, itibar komşulara da bağlı.
Doğrulama e-postası için asıl belirleyici, kendi alan adının SPF, DKIM ve
DMARC kayıtları.

### KVKK ve GDPR

- Yurt dışındaki bir sağlayıcıya e-posta adresi gitmesi yurt dışına
  aktarımdır. KVKK'da hiçbir ülke için yeterlilik kararı yok. Bu yüzden AB'de
  barındırma, KVKK açısından aktarımı ortadan kaldırmıyor. Yalnızca AB
  kullanıcıları için GDPR tarafını kolaylaştırıyor.
- Aktarım için standart sözleşme gerekiyor. Sözleşme imzadan sonra 5 iş günü
  içinde Kurul'a bildirilmeli (CAPTCHA araştırmasındaki kaynak).
- Sağlayıcı burada veri işleyen. Gönderilen veri az tutulmalı: adres, kod,
  link. Görünen ad gerekmiyor.
- Her self-hoster kendi verisinin sorumlusu. Genel SMTP bu yüzden önemli:
  Türkiye'de barındırılan bir relay (Inbox, Uzman Posta, SenderTR gibi) ya da
  kendi posta sunucusu da kullanılabilir. Bu sağlayıcılar değerlendirilmedi.
- Admin e-postayı açınca, CAPTCHA'daki gibi bir pencere aydınlatma metnine
  eklenecek bir paragraf vermeli.

## Resmî hub için maliyet

Varsayımlar:
- Aylık fiyat, vergi hariç.
- Azure'da e-posta başına ~50 KB veri.
- SES'te SNS ve veri ücreti dahil değil (bu hacimde çok küçük).
- Ara değerler, sayfalardaki birim fiyatlardan hesaplandı.

| Aylık e-posta | 1k | 10k | 100k | 1M |
|---|---|---|---|---|
| SES à la carte | 0,10 $ | 1 $ | 10 $ | 100 $ |
| SES Essentials (yeni hesap varsayılanı) | 0,16 $ | 1,60 $ | 16 $ | 160 $ |
| Scaleway TEM Essential | ~0,18 € | ~2,43 € | ~24,93 € | ~249,93 € (Scale planıyla 260 €) |
| Azure ACS | ~0,26 $ | ~2,56 $ | ~25,60 $ | ~256 $ |
| ZeptoMail (eski fiyat†) | 0 $ (ilk kredi) | 2,50 $ | 25 $ | 250 $ |
| Cloudflare Email Service | 5 $ (Workers Paid) | 7,45 $ | 38,95 $ | 353,95 $ |
| Resend | 0 $ (günde 100 sınırıyla) | 20 $ | 35 $ | 650 $ |
| Postmark (en ucuz plan) | 15 $ | 15 $ | 126 $ | 1.206 $ |

**Gerçekçi hacim (varsayım):** Her kayıt yaklaşık 1–1,5 e-posta demek
(doğrulama ve bazen yeniden gönderme). Buna şifre sıfırlamalar eklenir.
Ayda 5.000 kayıt bile ~10.000 e-posta eder. Bu hacimde SES, Scaleway ve
Azure ayda 1–3 $ tutar. Fark önemsiz; karar operasyona göre verilmeli.

### SES hâlâ en ucuz mu? Pürüzleri

Evet. Büyük sağlayıcılar arasında 1.000 e-posta başına 0,10 $ ile en ucuzu.
Pürüzler:

1. **Plan varsayılanı.** 21.07.2026'dan beri yeni SES hesapları Essentials
   planında başlıyor: 0,16 $/1.000. 1.06.2025'ten beri SES kullanmamış eski
   hesaplar da öyle. Konsolda "Cancel plan" ile à la carte'a (0,10 $)
   dönülüyor. Varsayılan olarak Essentials'a konan hesapta ilk iptal hemen
   geçerli oluyor. Dönülmezse %60 fazla ödenir.
2. **Ücretsiz katman yok.** Eski "ayda 3.000 ücretsiz" yeni hesaplarda yok;
   bu değişiklik 15.07.2025'te geldi†. SES fiyat sayfası artık yalnızca 6 ay
   geçerli kredilerden söz ediyor. "Free account plan" bazı servisleri
   kısıtlıyor; üretim için "Paid account plan" seçilmeli.
3. **Sandbox.**
   - Yalnızca doğrulanmış alıcılara gönderim, 24 saatte 200, saniyede 1.
   - Üretim başvurusunda site URL'si, e-posta türü (transactional) ve bir
     bounce/şikâyet süreci olduğunun onayı isteniyor.
   - İlk yanıt 24 saat içinde geliyor; ek bilgi istenirse uzuyor.
   - Sandbox ve kotalar bölge başına ayrı.
4. **Bounce ve şikâyet işleme zorunlu.**
   - Üç yoldan biri açık olmalı: e-posta ile geri bildirim (varsayılan açık),
     SNS bildirimi ya da event publishing.
   - Bounce oranı %5'e ulaşırsa hesap incelemeye alınıyor, %10'da gönderim
     durdurulabiliyor. Şikâyet eşikleri %0,1 ve %0,5.
   - Hesap düzeyi bastırma listesi (suppression list) 25.11.2019 sonrası
     hesaplarda varsayılan açık.
   - Gmail, SES'e şikâyet verisi göndermiyor. Gmail tarafı için Google
     Postmaster Tools gerekiyor.
5. **AWS sürtünmesi.** IAM'den türetilen SMTP kimlik bilgileri, bölge seçimi,
   DKIM DNS kayıtları, faturalama alarmı. Self-hoster için ağır; resmî hub
   için bir kerelik iş.
6. **Port.** SES 587 ve 2587'yi de dinliyor. Bu yüzden Hetzner'de (465
   kapalı) ve DigitalOcean'da (25, 465, 587 kapalı) 2587 ile çalışıyor.

**Öneri:** Resmî hub için SES, `eu-central-1`, à la carte, SMTP 587.
- Bounce için önce varsayılan e-posta geri bildirimi ve bastırma listesi
  yeterli. SNS → webhook sonraki bir faza kalır.
- Yedek: Scaleway TEM. AB şirketi, fiyatı SES'e yakın, kurulumu daha basit.
- Cloudflare Email Service de cazip, çünkü lobbyforge.org zaten Cloudflare
  DNS'te. Ama:
  - hâlâ beta;
  - SMTP'si yalnızca 465'te (yeni Hetzner sunucularında 465 kapalı);
  - ücretsiz 3.000 için bile 5 $'lık plan gerekiyor.

  Beta'dan çıkınca yeniden bakılmalı.

## Kendi posta sunucusunu kurmak

| | Lisans | Son sürüm | Not |
|---|---|---|---|
| Postfix | IBM Public License / EPL 2.0 | — | Klasik MTA. DKIM için ayrıca OpenDKIM ya da rspamd gerekiyor |
| docker-mailserver | MIT | v16.0.1 (4 Eylül 2026) | Postfix + Dovecot + rspamd tek pakette |
| Stalwart | AGPL-3.0 + ticari lisans (SELv2) | v0.16.24 (27 Eylül 2026) | Rust, tek ikili; SMTP, IMAP, JMAP, web yönetimi |
| Maddy | GPL-3.0 | v0.9.6 (3 Ekim 2026) | Go, tek ikili, basit yapılandırma |

Yazılımın kendisi sorun değil. Sorun, gönderilen e-postanın karşı tarafa
ulaşması.

**Port 25 çoğu VPS'te kapalı:**

| Sağlayıcı | Durum |
|---|---|
| Hetzner Cloud | 25 ve 465 varsayılan kapalı. Bir ay müşteri olup ilk faturayı ödedikten sonra gerekçeli talep açılabiliyor; karar duruma göre. 587 açık |
| DigitalOcean | 25, 465 ve 587 kapalı. Üçüncü taraf bir servis öneriyorlar |
| AWS EC2 / Lambda | 25 kısıtlı. Bölge başına form; 48 saate kadar sürebiliyor |
| Oracle Cloud | 23.06.2021 sonrası hesaplarda 25 kapalı. Servis limiti talebiyle açılıyor |
| Akamai (Linode) | 2019 sonrası bazı yeni hesaplarda 25, 465, 587 kapalı. Ayrıntılı gerekçeyle destek talebi |
| Vultr | 25 varsayılan kapalı, destek talebiyle açılıyor† |
| OVH | Açık† |

**Diğer gerçekler:**
- **IP itibarı:** VPS IP blokları sık sık kara listelerde. Yeni bir IP'nin
  "ısınması" gerekiyor. Bu kısmı ölçmedik.
- **PTR/rDNS:** Gmail tüm gönderenlerden geçerli ileri ve geri DNS istiyor.
- **SPF, DKIM, DMARC:**
  - Gmail tüm gönderenlerden SPF veya DKIM, TLS ve %0,3'ün altında spam
    oranı istiyor.
  - Günde 5.000'den fazla gönderenlerden SPF ve DKIM birlikte, DMARC,
    hizalanmış From ve pazarlama e-postasında tek tıkla abonelikten çıkma
    istiyor.
  - Kasım 2025'ten beri kurala uymayan e-postayı kalıcı hatayla reddediyor†.
  - Yahoo aynı kuralları uyguluyor.
  - Microsoft (Outlook.com) 5 Mayıs 2025'ten beri günde 5.000'den fazla
    gönderende uymayan e-postayı `550 5.7.515` ile reddediyor.
- Doğrulama e-postası transactional. Tek tıkla abonelikten çıkma şartı ona
  uygulanmıyor. Ama SPF/DKIM, PTR ve TLS her gönderen için geçerli.

**Sonuç:** LobbyForge bir posta sunucusu paketlememeli ve self-hostere
kurmasını önermemeli. Öneri: genel SMTP + bir relay. Zaten posta sunucusu
işleten (Stalwart, docker-mailserver, Mailcow) aynı SMTP ayarlarıyla ona
bağlanır. Araştırmanın başındaki tahmin doğrulandı.

## Önerilen tasarım

### Taşıma katmanı

- `apps/web/lib/mail/` içinde tek bir giriş: `sendMail({ to, template,
  locale, vars })`.
- Aktarıcılar: `smtp` (nodemailer) ve `none`. Geliştirmede `smtp` mailpit'e
  (`localhost:19525`) bakar.
- **nodemailer:**
  - Sürüm 10.0.14 (3 Ekim 2026), MIT-0 lisans.
  - Çalışma zamanı bağımlılığı yok; TypeScript tipleri paketin içinde;
    Node 20+.
  - Tedarik zinciri izi küçük: tek paket.
  - Ama Eylül 2026'nın sonunda bir dizi güvenlik bildirimi yayımlandı:
    adres ayrıştırıcıda DoS, bozuk alıcı zarfı ve transport'lar arasında
    paylaşılan DNS önbelleği yüzünden SMTP kimlik bilgisi sızması (10.0.2'de
    düzeldi). Hepsi 10.0.x içinde kapandı.
  - Sürüm `>=10.0.14` olarak sabitlenmeli, güncellemeler hızlı alınmalı. Biz
    tek bir transport ve zod ile doğrulanmış adres kullanacağımız için risk
    düşük.
- **HTTP API adaptörleri v1'de gerekmiyor:**
  - SES, Resend, Scaleway, Brevo, Mailgun, Postmark ve SMTP2GO'nun hepsi
    SMTP veriyor.
  - DigitalOcean gibi 25/465/587'yi kapatan yerlerde bile 2525 ya da 2587
    açan sağlayıcılar var.
  - `@aws-sdk/client-sesv2` 9 doğrudan bağımlılık getiriyor (`@smithy/*`,
    `@aws-sdk/*`). Kazanç az.
  - HTTP adaptörü ancak iki durumda değer: SMTP'si yalnızca 465'te olan
    Cloudflare'i 465'in kapalı olduğu bir sunucuda kullanmak, ya da bounce
    olaylarını sağlayıcının mesaj kimliğiyle eşleştirmek. Faz 5'e kalır.
- **Gönderim kaydı bloke etmemeli.** Kayıt başarılı döner. Gönderim 10 sn
  zaman aşımıyla denenir; hata loglanır ve Doctor sayacına yazılır. Kullanıcı
  "yeniden gönder" diyebilir. Bu hacimde kuyruk veya outbox gerekmiyor.
- **Şablonlar:** düz metin + basit HTML, kullanıcının `locale`'ine göre en/tr
  katalogdan. Uzak görsel ve takip pikseli yok.

### Yapılandırma

Ortam değişkenleri veritabanını ezer. Admin ekranı bunları kilitli gösterir
(CAPTCHA §3.2 gibi):
- `LOBBYFORGE_SMTP_HOST`, `LOBBYFORGE_SMTP_PORT`
- `LOBBYFORGE_SMTP_SECURITY`: `tls` | `starttls` | `none` (`none` yalnızca
  localhost'a)
- `LOBBYFORGE_SMTP_USER`, `LOBBYFORGE_SMTP_PASSWORD`
- `LOBBYFORGE_MAIL_FROM` (ör. `LobbyForge <no-reply@ornek.org>`)
- `LOBBYFORGE_EMAIL_VERIFICATION`: `off` | `optional` | `required`. Acil
  durum anahtarı da budur.

`instance_settings`'e eklenecekler (migration 0046+):

| Sütun | Varsayılan |
|---|---|
| `mail_transport` (`none` / `smtp`) | `none` |
| `smtp_host`, `smtp_port`, `smtp_security`, `smtp_username` | null |
| `smtp_password_encrypted` | null |
| `mail_from` | null |
| `email_verification_mode` (`off` / `optional` / `required`) | `off` |
| `email_verification_scope` jsonb | `{"open_register":true,"invite_register":false}` |
| `email_verification_enforced_since` timestamptz | null |
| `disposable_email_block` boolean | `false` (hub'da `true`) |

**Gizli anahtar:** CAPTCHA §3.3'teki yapının aynısı.
- AES-256-GCM. Anahtar: `HKDF-SHA256(session secret, info
  "lobbyforge:smtp-secret:v1")`.
- Biçim: `v1.<iv>.<ciphertext>.<tag>`.
- Tarayıcıya hiç dönmez; API yalnızca `{ secretSet, secretHint }` verir.
- CAPTCHA koduyla ortak bir `lib/secret-box.ts`'ye çıkarılmalı; amaç etiketi
  parametre olur.

**Güvenlik:** Admin ekranından girilen SMTP host'u bir SSRF yüzeyi. Admin
güvenilir, yine de:
- yalnızca 25, 465, 587, 2465, 2525, 2587 portları kabul edilir;
- metadata adresi (169.254.169.254) ve link-local reddedilir;
- TLS varsayılan; sertifika doğrulaması kapatılamaz (localhost hariç).

### Operasyon: test, Doctor, mailpit

**"Test e-postası gönder" düğmesi** (Admin → E-posta). Adminin kendi adresine
gönderir ve sonucu sınıflandırır:
- bağlantı zaman aşımı → "Sağlayıcınız bu portu engelliyor olabilir; 2525
  veya 2587 deneyin";
- TLS hatası;
- kimlik doğrulama hatası (535);
- gönderen adresi reddi (553/554).

`required` moda geçiş, son test başarılı değilse yapılamaz (arayüzde ve
sunucuda kontrol).

**Doctor:**
- `required` açık ama transport yok → kritik.
- Son gönderimlerde hata veya kimlik doğrulama hatası → uyarı.
- From alan adında SPF TXT ya da `_dmarc` kaydı yok → ipucu. DKIM seçicisi
  bilinmeden kontrol edilemez; isteğe bağlı bir "DKIM selector" alanı
  eklenebilir.
- Port 25 seçilmiş → "çoğu VPS'te kapalı" ipucu.
- Admin bir günlük sınır girdiyse ve gönderim ona yaklaşıyorsa → uyarı.

**Geliştirme ve e2e:** mailpit zaten var. e2e stack'te web servisi
`LOBBYFORGE_SMTP_HOST=mailpit` ile başlar; Playwright kodu mailpit'in HTTP
API'sinden okur. Birim testleri transport'u mock'lar.

### Doğrulama akışı

#### Link mi, 6 haneli kod mu?

İkisi birden, aynı e-postada.

| | Link | 6 haneli kod |
|---|---|---|
| Aynı cihaz, tarayıcı | Tek tık | Kopyala-yapıştır |
| Masaüstü uygulaması (Tauri) | Sistem tarayıcısında açılır; geri dönmek için deep link gerekir | Uygulamaya yazılır; deep link gerekmez |
| E-posta telefonda, kayıt bilgisayarda | Telefonda doğrular; bilgisayardaki oturum durumu yenilemeli | Bilgisayara yazılır |
| Güvenlik tarayıcısı linki açarsa | GET'te tüketilirse bozulur | Etkilenmez |
| Kaba kuvvet | 256 bit, sorun yok | 1.000.000 olasılık; deneme sınırı şart |

Kurallar:
- Link `LOBBYFORGE_APP_ORIGIN/verify-email?t=…` biçiminde.
- GET yalnızca bir onay sayfası gösterir, token'ı tüketmez. "E-postamı
  doğrula" düğmesi POST eder; token orada tüketilir. Sayfa
  `Referrer-Policy: no-referrer` gönderir.
- Link oturum açmaz. Başka cihazda açılınca yalnızca adresi doğrular. Böylece
  bir "sihirli giriş linkine" dönüşmez.
- Açık oturum, doğrulamayı gerçek zamanlı kanal üzerinden ya da sayfa odağa
  gelince yeniden sorgulayarak fark eder.
- Kod 15 dk geçerli, en fazla 5 yanlış deneme. Link 24 saat geçerli. Yeni
  gönderim eskisini geçersiz kılar.
- Kod konu satırına yazılmaz (kilit ekranı bildirimlerinde görünmesin).

#### Token saklama

`users` tablosuna `email_verified_at timestamptz null` eklenir. Boolean yerine
zaman, çünkü denetimde işe yarıyor ve adres değişince sıfırlanabiliyor.

Yeni tablo `email_tokens`:
- `id`, `user_id`, `purpose` (`verify` / `change` / `reset`), `target_email`
  (gönderildiği adres).
- `token_hash`: 32 bayt rastgele değerin SHA-256'sı.
- `code_hash`: `HMAC-SHA256(kod)`. Anahtar ayrı bir HKDF etiketiyle türetilir;
  token `id`'si de girdiye katılır.
- `code_attempts`, `expires_at`, `code_expires_at`, `consumed_at`,
  `created_at`.

Kurallar:
- Kullanıcı ve amaç başına tek aktif kayıt.
- Karşılaştırma `timingSafeEqual` ile.
- Tüketme tek bir koşullu `UPDATE … WHERE consumed_at IS NULL AND expires_at
  > now()` ile yapılır. Çift tıklama yarışı böyle önlenir.
- Süresi geçen kayıtlar periyodik olarak silinir.

#### Hız sınırları (öneri)

| Ne | Sınır |
|---|---|
| Doğrulama e-postası, hesap başına | 60 sn bekleme; saatte 5, günde 10 |
| Aynı hedef adres, hesaptan bağımsız | Saatte 3 (başkasının kutusunu bombalamayı önler) |
| Gönderim, IP başına | 15 dk'da 10 |
| Kod denemesi | Kod başına 5; hesap başına 15 dk'da 10 |
| Link POST, IP başına | Dakikada 10 |
| Instance geneli | Admin günlük sınır girdiyse %80'de Doctor uyarısı; %100'de gönderim durur, kullanıcıya "sonra deneyin" denir |

Sayaçlar Redis'te, `auth-throttle.ts` düzeninde tutulur. "Yeniden gönder"
düğmesi geri sayım gösterir.

#### Doğrulanmamış hesap ne yapabilir?

Discord'da "Low" doğrulama seviyesindeki bir sunucuda, e-postası doğrulanmamış
kullanıcı konuşamıyor. Benzer bir model:

| | `optional` | `required` |
|---|---|---|
| Giriş, profil, ayarlar, e-posta değiştirme, hesap silme | Evet | Evet |
| Üye olduğu sunucuları okuma | Evet | Evet |
| Mesaj, DM ve tepki | Evet | Hayır |
| Ses kanalına girme | Evet | Hayır |
| Sunucu, kanal ve davet oluşturma | Evet | Hayır |
| Dosya yükleme | Evet | Hayır |
| Bot, webhook ve bot token oluşturma | Evet | Hayır |
| Hub: eklenti yayınlama, topluluk listeleme | Evet | Hayır |

- Kısıt sunucu tarafında, tek bir `requireVerifiedEmail(user, action)`
  kontrolüyle uygulanır. Arayüz yalnızca banner ve devre dışı düğme gösterir.
- Sahip ve adminler kısıtlanmaz. Admin bir kullanıcıyı elle doğrulanmış
  işaretleyebilir (denetim kaydıyla).
- Misafirler etkilenmez; e-postaları yok. Google ile girenler, Google
  `email_verified=true` dediyse doğrulanmış sayılır.
- Sunucu bazında doğrulama seviyesi (Discord gibi) sonra eklenebilir. v1'de
  yalnızca instance ayarı.
- **Adres işgali:** Biri başkasının adresiyle kayıt olursa gerçek sahip kayıt
  olamaz. Çözüm: doğrulanmamış hesap adresi "sahiplenmez". Gerçek sahip
  şifre sıfırlamayla adresi kanıtlar ve hesabı alır. İsteğe bağlı: `required`
  modunda 7 gün içinde doğrulanmayan yeni hesaplar silinir.
- **Hesap varlığı sızıntısı:** Doğrulama gelince kayıt cevabı her zaman
  "e-postanızı kontrol edin" olabilir. Adres kayıtlıysa sahibine "bu adresle
  kayıt denendi" e-postası gider. Kayıt deneyimini değiştirdiği için ayrı
  karar.

#### E-posta değiştirme

1. Mevcut şifre istenir.
2. Yeni adrese kod ve link gider (`purpose=change`, `target_email`).
   `users.email` hemen değişmez.
3. Onayda adres hâlâ boşta mı diye bakılır (yarış kontrolü). Boştaysa
   değişir ve `email_verified_at = now()` olur.
4. Eski adrese "adresiniz değişti" bildirimi gider.
5. Diğer oturumlar isteğe bağlı kapatılır (`revokeOtherSessions`).

`off` modunda (transport yoksa) e-posta değişikliği bugünkü gibi doğrudan
yapılır.

#### Tek kullanımlık alan adları

| Liste | Lisans | Boyut | Bakım |
|---|---|---|---|
| disposable-email-domains/disposable-email-domains | CC0 (AGPL ile uyumlu) | ~9.200 satır | Son commit 3 Ekim 2026, ~5.500 yıldız. Ekleme için kanıt (ekran görüntüsü) isteniyor |
| disposable/disposable | MIT | ~5.200 alan adı + "strict" liste | 13+ kaynaktan her gün otomatik üretiliyor |

Öneri:
- CC0 listeyi repoya bir veri dosyası olarak koymak; ayda bir bir script ile
  güncelleme PR'ı açmak. Elle seçilmiş olduğu için yanlış pozitifi daha az.
- Alt alan adları da eşleşir. Admin kendi engel ve izin listesini ekleyebilir.
- Resmî hub'da açık, self-host'ta varsayılan kapalı.
- MX sorgusu v1'de yok.
- Gmail'deki nokta ve `+etiket` normalizasyonu varsayılan kapalı; artı
  adresleme meşru bir kullanım.

#### Bounce ve şikâyet

- **v1:** SMTP gönderiminde anında gelen 5xx hatası kaydedilir; kullanıcıya
  "bu adrese gönderilemedi" denir. Gecikmeli bounce'ları relay'in kendi
  bastırma listesi yönetir (SES'te varsayılan açık).
- **Faz 5:** İsteğe bağlı bir webhook, `/api/webhooks/mail/<sağlayıcı>`.
  - Önce SES (SNS imzası doğrulanır), sonra Resend.
  - Bounce olan adres `email_bouncing_at` ile işaretlenir; kullanıcı "adresinizi
    güncelleyin" banner'ı görür.
  - Şikâyet gelen adrese doğrulama ve sıfırlama dışında e-posta gitmez.
- Doğrulama sistemi bounce oranını zaten düşürür. SES de kayıtta çift onay
  (double opt-in) öneriyor.

#### Şifre sıfırlama

Aynı tablo ve aynı gönderici, `purpose=reset`:
- Yanıt her zaman aynı ve aynı sürede: "Hesap varsa e-posta gönderildi."
- Link 30–60 dk geçerli ve tek kullanımlık; kod da kabul edilir.
- Başarıda diğer oturumlar kapatılır (`revokeOtherSessions`).
- CAPTCHA araştırmasındaki "şifre sıfırlamada her zaman sor" kuralı
  uygulanır.
- Transport yoksa ekran "yöneticinize başvurun" der.
- Başarılı sıfırlama e-postayı da doğrulanmış sayar; adres kanıtlanmıştır.

#### Resmî hub

- `required` baştan açık. Tek kullanımlık alan adı engeli açık. Turnstile/
  ALTCHA ile e-posta doğrulaması birlikte çalışır.
- Doğrulanmamış hub hesabı eklenti yayınlayamaz, topluluk listeleyemez,
  marketplace'ten kurulum başlatamaz.
- Hub ileride self-host'lara kimlik sağlayıcı olursa `email_verified` iddiası
  yalnızca doğrulanmış hesaplarda `true` olmalı.
- Gönderen `no-reply@lobbyforge.org`, SES `eu-central-1`. SPF, DKIM ve DMARC
  kayıtları Cloudflare DNS'e eklenir. DMARC `p=none` ile başlar, raporlar
  temizse `quarantine`'e çıkar.

### Mevcut kurulumlar için geçiş

- Migration yalnızca boş sütunlar ekler; mod `off` başlar. Hiçbir mevcut
  kurulumun davranışı değişmez.
- Modlar:
  - `off`: bugünkü gibi; e-posta gönderilmez.
  - `optional`: doğrulama e-postası gider, banner görünür, kısıt yok. Admin
    üye listesinde doğrulama durumunu görür.
  - `required`: yalnızca `email_verification_enforced_since` sonrasında açılan
    hesaplar kısıtlanır. Eski hesaplar banner görür ama kilitlenmez.
- Admin isterse "mevcut hesaplar da doğrulasın" seçeneğini bir son tarihle
  açar. O tarihe kadar yalnızca banner gösterilir.
- Sahip hesabı hiçbir zaman kilitlenmez.
- `required`, transport yapılandırılıp test e-postası başarılı olmadan
  seçilemez.
- Transport sonradan bozulursa kayıt çalışmaya devam eder, yeni hesap
  doğrulanmamış kalır ve Doctor kritik uyarı verir. Admin
  `LOBBYFORGE_EMAIL_VERIFICATION=off` ile anında kapatabilir.
- Davetle kayıt varsayılan olarak doğrulamasız, CAPTCHA'daki gibi. Davet
  zaten bir kapı.

## Self-hoster için ücretsiz seçenekler (<1.000/ay)

1. **Brevo:** Günde 300 (ayda ~9.000), kart yok, AB'de, SMTP'de 2525 portu
   var. Dikkat: gönderim için hesap onayı bekleniyor; arayüz pazarlama
   odaklı.
2. **SMTP2GO:** Ayda 1.000, günde 200, kart yok. Ana portu 2525, yani
   DigitalOcean'da bile çalışıyor. AB veri merkezi seçeneği var. Dikkat:
   1.000 sert sınır; alan adı doğrulanana kadar saatte 25†.
3. **Resend:** Ayda 3.000, günde 100, 3 alan adı, AB bölgesi, 2587/2465
   portları. Dikkat: günde 100, açık kayıtlı bir toplulukta yoğun bir günde
   dolabilir.
4. **Mailjet:** Ayda 6.000, günde 200, AB'de. Dikkat: ücretsiz e-postalarda
   Mailjet logosu var.
5. **Scaleway TEM:** Ayda 300 ücretsiz, sonra 1.000 başına 0,25 €; 1.000
   e-posta 1 €'nun altında. AB şirketi. Dikkat: Scaleway hesabı, ödeme
   yöntemi ve kimlik doğrulaması gerekiyor.
6. **Mailgun:** Günde 100, 1 alan adı, AB bölgesi. Dikkat: log 1 gün
   tutuluyor; hata ayıklamak zor.
7. **Gmail (kişisel):** Günde 500, uygulama şifresiyle (2 adımlı doğrulama
   şart). Dikkat: gönderen Gmail adresi olur, kendi alan adı olmaz. Yalnızca
   test ya da küçük, kapalı topluluklar için.

**Önerilmeyenler:**
- SendGrid: ücretsiz plan yok.
- MailerSend: ayda 500 ve kredi kartı.
- Postmark: ayda 100.
- Azure: ücretsiz katman yok, kurulum ağır.
- SES: yeni hesapta ücretsiz katman yok, sandbox var. AWS'yi bilen için yine
  de çok ucuz.
- Cloudflare: alan adı zaten Cloudflare'da ve Workers Paid ödeniyorsa iyi bir
  seçenek; değilse 5 $/ay.

**Hepsi için:** Kendi alan adına SPF, DKIM ve DMARC kayıtları eklenmeli;
sağlayıcı kayıtları veriyor. Günlük sınır; doğrulama, yeniden gönderme ve
şifre sıfırlamanın toplamını kapsar.

## Riskler

- **Spam klasörü.** Doğrulama e-postası spam'e düşerse kullanıcı takılır.
  Karşılığı: kod, yeniden gönderme, admin elle doğrulama ve kurulum
  dokümanında DNS rehberi.
- **Relay kesintisi ya da kota dolması.** Kayıt çalışır, hesap doğrulanmamış
  kalır, Doctor uyarır.
- **Tek kullanımlık adresler.** Liste her şeyi yakalamaz. E-posta doğrulaması
  maliyeti artırır, sıfırlamaz.
- **Yanlış yapılandırma.** Test düğmesi ve Doctor bunun için.
- **KVKK.** Yurt dışındaki relay aktarım demek; admin uyarılmalı.
- **nodemailer güvenlik bildirimleri.** Sık güncelleme gerekiyor.
- **Masaüstü.** Kod sayesinde deep link gerekmiyor. Ama doğrulama durumunun
  WebView'da yenilenmesi WebKitGTK ve WKWebView'da test edilmeli.

## Fazlı plan (tek geliştirici, toplam ~2,5–3,5 hafta)

0. **S (1 gün):** Migration'lar.
   - `users.email_verified_at`, `email_tokens`, `instance_settings` e-posta
     sütunları.
   - CAPTCHA ile ortak `lib/secret-box.ts`.
1. **M (3–4 gün):** Gönderim altyapısı.
   - `lib/mail` ve nodemailer SMTP transport, ortam değişkenleri.
   - en/tr şablonlar.
   - Admin "test e-postası" düğmesi, temel Doctor kontrolleri.
   - e2e stack'te mailpit.
2. **M (4–6 gün):** Doğrulama akışı.
   - Gönder, yeniden gönder ve doğrula (link + kod) uç noktaları; onay
     sayfası; banner.
   - `off/optional/required` modları ve sunucu tarafı kısıtlar.
   - Hız sınırları, tek kullanımlık alan adı listesi.
   - Birim testleri ve Playwright senaryosu.
3. **S/M (2–3 gün):** E-posta değiştirme ve şifre sıfırlama (aynı tablo,
   CAPTCHA entegrasyonu).
4. **S/M (2–3 gün):** Admin ve hub.
   - Admin ekranından şifreli SMTP gizli anahtarı.
   - Doctor DNS ipuçları (SPF/DMARC), KVKK penceresi.
   - Resmî hub: SES hesabı, à la carte'a geçiş, üretim başvurusu, DNS
     kayıtları.
5. **Sonra (M):** Bounce/şikâyet webhook'ları (önce SES/SNS), sunucu bazında
   doğrulama seviyesi, talep olursa HTTP adaptörleri.

## Kaynaklar

- Amazon SES ve AWS:
  - <https://aws.amazon.com/ses/pricing/>
  - <https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-ses-pricing-plans/>
  - <https://aws.amazon.com/blogs/messaging-and-targeting/introducing-amazon-simple-email-service-ses-pricing-plans/>
  - <https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-email.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html>
  - <https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html>
  - <https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html>
  - Aylık 3.000'lik SES kotasının kalkması (üçüncü taraf): <https://costgoat.com/pricing/amazon-ses>
- Resend: <https://resend.com/pricing>, <https://resend.com/docs/dashboard/domains/regions>, <https://resend.com/docs/send-with-smtp>
- Brevo: <https://www.brevo.com/pricing/> (sayfadaki SSS: "up to 300 emails per day", Starter 9 $ / 7 €), <https://developers.brevo.com/docs/smtp-integration>, <https://help.brevo.com/hc/en-us/articles/360001005510-Data-storage-location>
- Mailjet: <https://www.mailjet.com/pricing/>, <https://documentation.mailjet.com/hc/en-us/articles/360042712274-Where-is-my-personal-data-stored>
- Mailgun: <https://www.mailgun.com/pricing/>, <https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp>
- Postmark: <https://postmarkapp.com/pricing>, <https://postmarkapp.com/eu-privacy>, <https://postmarkapp.com/developer/user-guide/send-email-with-smtp>
- SMTP2GO: <https://www.smtp2go.com/pricing/>, <https://support.smtp2go.com/hc/en-gb/articles/223087947-Free-Plan>, <https://support.smtp2go.com/hc/en-gb/articles/223087627-SMTP-Settings>, <https://support.smtp2go.com/hc/en-gb/articles/12974008254873-EU-Data-Center>
- MailerSend: <https://www.mailersend.com/pricing>, <https://www.mailersend.com/legal/privacy-policy>
- SendGrid: <https://www.twilio.com/en-us/changelog/sendgrid-free-plan>; deneme ve fiyat (üçüncü taraf): <https://dreamlit.ai/blog/best-sendgrid-alternatives>
- Scaleway TEM: <https://www.scaleway.com/en/pricing/managed-services/>, <https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/>
- ZeptoMail: <https://www.zoho.com/zeptomail/pricing.html>, <https://www.zoho.com/zeptomail/help/api/multiple-data-centers.html>
- Azure Communication Services: <https://learn.microsoft.com/en-us/azure/communication-services/concepts/email-pricing>, <https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits>
- Cloudflare Email Service:
  - <https://developers.cloudflare.com/email-service/>
  - <https://developers.cloudflare.com/email-service/platform/pricing/>
  - <https://developers.cloudflare.com/email-service/platform/limits/>
  - <https://developers.cloudflare.com/email-service/api/send-emails/smtp/>
  - <https://developers.cloudflare.com/email-service/configuration/domains/>
  - <https://developers.cloudflare.com/changelog/post/2026-06-08-smtp-submission/>
- Gmail ve Workspace:
  - <https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace>
  - <https://support.google.com/mail/answer/22839>
  - <https://support.google.com/accounts/answer/185833>
- Gönderen kuralları:
  - Gmail: <https://support.google.com/a/answer/81126>
  - Gmail Kasım 2025 uygulaması (üçüncü taraf): <https://redsift.com/blog/gmails-enforcement-ramps-up-what-bulk-senders-need-to-know>
  - Yahoo: <https://senders.yahooinc.com/best-practices/>
  - Microsoft: <https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%e2%80%99s-new-requirements-for-high%e2%80%90volume-senders/4399730>
- Port 25:
  - Hetzner: <https://docs.hetzner.com/cloud/servers/faq/>
  - DigitalOcean: <https://docs.digitalocean.com/support/why-is-smtp-blocked/>
  - AWS: <https://repost.aws/knowledge-center/ec2-port-25-throttle>
  - Oracle: <https://docs.oracle.com/en-us/iaas/releasenotes/changes/f7e95770-9844-43db-916c-6ccbaf2cfe24/index.htm>
  - Akamai: <https://techdocs.akamai.com/cloud-computing/docs/send-email>
  - Vultr (forum): <https://discuss.vultr.com/discussion/2188/smtp-port-25-blocked>
- Posta sunucuları: <https://github.com/docker-mailserver/docker-mailserver>, <https://github.com/stalwartlabs/stalwart>, <https://github.com/foxcpp/maddy>, <https://www.postfix.org/>
- nodemailer: <https://github.com/nodemailer/nodemailer>, <https://github.com/nodemailer/nodemailer/security/advisories>, `npm view nodemailer` (10.0.14, 2026-10-03), `npm view @aws-sdk/client-sesv2 dependencies`
- Tek kullanımlık alan adları: <https://github.com/disposable-email-domains/disposable-email-domains>, <https://github.com/disposable/disposable>
- OWASP: <https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html>
- Linkleri açan güvenlik tarayıcıları: <https://www.suped.com/learn/email-deliverability/do-email-security-software-solutions-click-hyperlinks-in-emails>, <https://learn.microsoft.com/en-us/defender-office-365/safe-links-about>
- Discord doğrulama seviyeleri: <https://support.discord.com/hc/en-us/articles/216679607-Verification-Levels>
- KVKK ve yurt dışına aktarım: <https://www.mondaq.com/turkey/privacy-protection/1740066/kvkk-yurt-d%C4%B1%C5%9F%C4%B1na-veri-aktar%C4%B1m%C4%B1-rehberi-2026-g%C3%BCncel-d%C3%BCzenlemeler>
- Türkiye'deki relay'ler (değerlendirilmedi): <https://useinbox.com/tr/islemsel-eposta>, <https://uzmanposta.com/>, <https://sendertr.com/>

**Doğrulanamayanlar:**
- SES'in AWS "Free account plan"da açık olup olmadığı; aylık 3.000 ücretsiz
  kotanın tam olarak 15.07.2025'te kalktığı (tarih yalnızca üçüncü taraf
  kaynakta).
- SNS'in güncel ücretsiz kotası ve HTTP bildirim fiyatı (sayfada rakam
  okunamadı).
- ZeptoMail'in 1 Temmuz 2026 sonrası kredi fiyatı. Tabloda eski 2,50 $
  kullanıldı.
- Cloudflare Email Service'te alan adının Cloudflare DNS'te olmasının şart
  olup olmadığı (limit sayfası "zone" diyor, alan adı sayfası açıkça
  söylemiyor) ve yeni hesabın günlük kotası.
- Cloudflare Email Sending'in herkese açık beta tarihi (16 Nisan 2026,
  yalnızca üçüncü taraf kaynakta).
- Brevo: ücretsiz transactional e-postalara marka eklenip eklenmediği;
  100k/ay fiyatı (üçüncü taraf ~82 $); veri yeri (yardım sayfası okunamadı).
- MailerSend: Hobby'nin 5,60 $ mı 7 $ mı olduğu (yıllık/aylık fark olabilir);
  ücretsiz kotanın Aralık 2025'te 3.000'den 500'e düştüğü (yalnızca üçüncü
  taraf); veri yeri.
- SMTP2GO'nun günlük 200 ve saatlik 25 sınırı (destek sayfası 403 verdi).
- Scaleway TEM'de yeni hesabın 10.000/ay varsayılan kotası.
- SendGrid deneme süresinin ayrıntıları ve 19,95 $ fiyatı.
- Azure ACS'nin SMTP desteğinin ayrıntıları.
- Mailgun ve SMTP2GO'nun 1M/ay fiyatı (satışla görüşme gerekiyor).
- Postmark'ın aşım formülü dışında hacim indirimi olup olmadığı.
- Vultr ve OVH'nin port 25 politikası (yalnızca forum/üçüncü taraf).
- Gmail'in Kasım 2025'ten beri kalıcı ret uyguladığı (Google sayfası
  tarih vermiyor; üçüncü taraf kaynaklar söylüyor).
- Sağlayıcıların teslim edilebilirlik sıralaması (ölçülmedi, genel kanı).
- Türkiye'deki relay'lerin fiyatı, limiti ve teslim edilebilirliği.
- Resend AB bölgesinin ücretsiz planda seçilebilip seçilemediği.
