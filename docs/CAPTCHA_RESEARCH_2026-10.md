# CAPTCHA araştırması ve öneri — 2026-10-04

Soru: LobbyForge'a reCAPTCHA ve Turnstile eklenmeli mi? Anahtarlar
isteğe bağlı mı olmalı, açıp kapatılabilmeli mi, görünmez/managed gibi
modlar sunulmalı mı?

## Karar

**Evet, eklenmeli. Ama varsayılan sağlayıcı reCAPTCHA ya da Turnstile değil,
kurulumun içinde çalışan ALTCHA olmalı.**

- **Turnstile** ilk harici seçenek olmalı; resmî hub da onu kullanmalı.
- **reCAPTCHA ve hCaptcha** yalnızca talep olursa eklenen isteğe bağlı
  adaptörler olarak kalmalı.
- **Nerede?** Kayıtta, hub kaydında, yeni misafir oluşturmada ve (ileride)
  şifre sıfırlamada her zaman sorulmalı. Girişte yalnızca şüpheli bir sinyal
  varsa sorulmalı (uyarlamalı). Ses, sohbet, webhook'lar ve Bot API'de hiç
  sorulmamalı.

**Neden ALTCHA?**
- Üçüncü tarafa veri gitmiyor, çerez yok. KVKK açısından yurt dışına
  aktarım da yok.
- İnternetsiz kurulumlarda çalışıyor.
- CSP'ye yeni bir origin eklemeyi gerektirmiyor.
- MIT lisanslı, AGPL bir self-host ürünle uyumlu.

**Captcha tek başına çözüm değil.** Çözücü servisleri (1.000 token başına
yaklaşık 1–1,5 $) ve insan çiftlikleri her captcha'yı aşar. Asıl kapılar hız
sınırları, davet/onay kuyruğu ve henüz olmayan **e-posta doğrulaması**.

## Bugünkü durum

**Var olan korumalar:**
- IP başına hız sınırları (`withApiSecurity`).
- Hesap başına kilit (`auth-throttle.ts`); sahibin kendi tarayıcıları kilide
  takılmasın diye cihaz çerezleri (`device-cookie.ts`).
- Davet ve onay kuyruğu.

**Açıklar:**
- **Credential stuffing:** Çok sayıda hesap, her biri az denemeyle, dönen
  IP'lerden denenince ne hesap kilidi ne IP sınırı devreye giriyor.
- **Açık kayıt:** `registrationMode=open` iken bot kaydını durduran bir şey
  yok.
- **Yeni misafir:** Her yeni misafir kimliği bir `users` satırı açıyor.
  Sınırı 30/dk/IP ve oturum yenilemeyle aynı kovayı paylaşıyor.

## Sağlayıcı karşılaştırması

| | ALTCHA (gömülü) | Cloudflare Turnstile | reCAPTCHA (Google Cloud Fraud Defense) | hCaptcha | Cap |
|---|---|---|---|---|---|
| Gizlilik | Üçüncü taraf yok, çerez yok | IP, TLS parmak izi ve UA Cloudflare'e gidiyor | 2 Nisan 2026'dan beri Google veri işleyen; `_GRECAPTCHA` çerezi | ABD'ye aktarım | Kendi sunucunda |
| Maliyet | Ücretsiz (MIT) | Ücretsiz, sınırsız (20 widget) | Ayda 10.000 ücretsiz, faturalama hesabı zorunlu | Basic ücretsiz; pasif mod yalnızca Pro'da | Ücretsiz (Apache-2.0) |
| İnternetsiz kurulum | Evet | Hayır | Hayır | Hayır | Evet |
| Kullanıcı deneyimi | Arka planda iş kanıtı (PoW), görünmez/otomatik | Managed, non-interactive, invisible | v2 kutucuk veya görünmez; v3 puan | Çoğunlukla resim bulmacası | Kutucuk |
| Erişilebilirlik | Etkileşimsiz | WCAG 2.2 AA iddiası | v2 resim/ses bulmacası zayıf | Şikâyet çok | Kutucuk |
| CSP'ye eklenecekler | Origin yok; worker için `worker-src 'self' blob:` | `challenges.cloudflare.com` (script, frame) | `google.com/recaptcha`, `gstatic.com` | `*.hcaptcha.com` | WASM |
| KVKK/GDPR | Aktarım yok | Yurt dışı aktarım; Cloudflare DPA'sı KVKK'dan bahsetmiyor | Google Cloud DPA'sında Türk SCC'leri var; CNIL 2023'te rıza aradı | ABD'ye aktarım | Aktarım yok |
| Bot çiftliğine karşı | Orta-düşük (CPU maliyeti) | İyi | v3 iyi; v2 resim bulmacası kırıldı | Orta | Orta |

**KVKK notları:**
- Herhangi bir ülke için yeterlilik kararı yok.
- Her kayıtta çalışan bir harici captcha "sürekli aktarım" sayılır. Standart
  sözleşme gerekir ve imzadan sonra 5 iş günü içinde Kurul'a bildirilmelidir.
- Güvenlik amaçlı, kesinlikle gerekli çerezler rızadan muaf tutulabilir.
- Her sunucu sahibi kendi verisinin sorumlusu. Varsayılanın ALTCHA olması bu
  yüzden kritik.

**Somut kesinti riski:** Turnstile, Cloudflare'in 18 Kasım 2025 kesintisinde
yüklenemedi. Harici captcha'yı girişe koşulsuz koymamanın nedeni bu.

## Önerilen mimari

**Sağlayıcı soyutlaması:**
- `lib/captcha/` altında `none | altcha | turnstile | recaptcha | hcaptcha`.
- Doğrulama `verifyCaptcha({ action, token, req })` ile yapılır. Sonuçlar:
  - `ok`
  - `missing | invalid | expired | duplicate` → istek reddedilir
  - `unavailable | misconfigured` → yedek sağlayıcıya geçilir

**ALTCHA:**
- HMAC anahtarı oturum gizli anahtarından ayrı bir etiketle türetilir.
- Challenge uç noktası: `GET /api/auth/captcha/challenge?action=…`.
- Algoritma PBKDF2/SHA-256 olur, böylece WASM gerekmez.
- `action` ve bitiş süresi (~5 dk) imzalanır.
- Tekrar kullanım Redis'te `SET NX` ile engellenir. Redis yoksa istek
  reddedilir.

**Yapılandırma:**
- v1: sağlayıcı ve anahtarlar ortam değişkeninden gelir (`LOBBYFORGE_CAPTCHA_*`).
- Admin → Authentication'da:
  - yüzey bazında aç/kapat
  - Turnstile modu
  - reCAPTCHA v3 eşiği
  - girişte kaç hatadan sonra sorulacağı
- Gizli anahtar istemciye hiç gitmez.

**Yüzeyler ve sağlayıcı çökerse ne olur:**

| Yüzey | Varsayılan | Sağlayıcı çökerse |
|---|---|---|
| Açık kayıt | Her zaman sor | ALTCHA'ya düş, o da yoksa reddet |
| Davetle kayıt | Kapalı (isteğe bağlı) | — |
| Hub kaydı | Turnstile + ALTCHA yedeği | ALTCHA |
| Yeni misafir (çerez yok) | Her zaman sor; ayrıca ayrı ve sıkı bir limit | ALTCHA, sonra reddet |
| Giriş ve masaüstü girişi | Uyarlamalı: cihaz çerezi varsa sorma. Hesapta ≥3 hata, IP eşiği aşılmış ya da instance'ta "saldırı modu" açıksa sor | Girişi engelleme: ALTCHA'ya düş, o da yoksa mevcut sınırlarla devam et |
| Şifre sıfırlama (gelince) | Her zaman sor | ALTCHA, sonra reddet |
| Webhook, Bot API, ses, sohbet, LiveKit, WS | Hiçbir zaman | — |

**Route'lara bağlanma sırası:**
1. `withApiSecurity` (ucuz kontroller önce)
2. zod ile ayrıştırma
3. `verifyCaptcha`
4. veritabanı ve parola hash işlemi

Harici doğrulama:
- 3 sn zaman aşımı, bir kez yeniden deneme.
- `hostname` ve `action` kontrolü.
- Bir devre kesici: sağlayıcı arka arkaya hata verirse 5 dk boyunca ALTCHA
  kullanılır.

**CSP:** Harici sağlayıcının origin'leri yalnızca widget olan sayfalarda
eklenir: `/login`, `/register`, `/join/*`, hub kaydı. Betik nonce ile yüklenir.
Harici bir betik şifre alanının olduğu sayfada çalışır; ALTCHA bu riski taşımaz.

**Doctor şunları kontrol etmeli:**
- Harici sağlayıcı seçili ama anahtar eksik.
- Gizli anahtar geçersiz (sahte tokenla deneme yapılarak).
- Üretimde test anahtarı kullanılıyor.
- `hostname` uyuşmazlığı ve kota/429 sayaçları.
- CSP'de sağlayıcı origin'i eksik.

**Aydınlatma metni:** Admin harici bir sağlayıcı seçince bir onay penceresi
açılmalı. Pencere KVKK m.9 yükümlülüğünü anlatmalı ve aydınlatma metnine
eklenecek hazır bir paragraf üretmeli. ALTCHA için tek cümle yeter: "Bot
koruması için tarayıcınız yerel bir hesaplama yapar; üçüncü tarafa veri
gönderilmez."

## Riskler

- **Yanlış güven duygusu.** E-posta doğrulaması da gerekli.
- **Sağlayıcı kesintisi.** Yedek sağlayıcı ve uyarlamalı giriş bunun karşılığı.
- **Yanlış pozitifler.** VPN, Tor ve gizlilik tarayıcıları haksız yere
  engellenebilir. ALTCHA'da da zayıf telefonlarda PoW süresi uzar.
- **Masaüstü webview uyumu.** WebKitGTK ve WKWebView'da doğrulanmadı.
- **Otomatik misafir oluşturan yollar.** Lobby'nin ses bileşeni ve oda sayfası
  `captcha_required` yanıtını alınca kullanıcıyı açık misafir girişine
  yönlendirmeli.

## Fazlı plan (tek geliştirici, toplam ~2–3 hafta)

0. **S (1–2 gün):** Captcha'sız kazanımlar.
   - Yeni misafir için ayrı limit.
   - Instance genelinde hatalı giriş sayacı ve "saldırı modu".
   - Kayıt ve misafir formuna honeypot alanı ve asgari doldurma süresi.
1. **M (4–6 gün):** `lib/captcha` ve ALTCHA.
   - Kayıt, hub kaydı, yeni misafir; uyarlamalı giriş.
   - Admin ayarları, en/tr metinler, testler.
2. **M (3–5 gün):** Turnstile adaptörü.
   - Sayfa bazlı CSP, yedek davranış ve devre kesici.
   - Doctor kontrolleri, KVKK penceresi.
   - Resmî hub'da açmak.
3. **S/M:** reCAPTCHA v3 ve hCaptcha adaptörleri (talep olursa); admin
   ekranından şifreli gizli anahtar; şifre sıfırlama entegrasyonu.

## Kaynaklar

- ALTCHA: <https://github.com/altcha-org/altcha>, <https://altcha.org/pricing/>
- Turnstile:
  - <https://developers.cloudflare.com/turnstile/concepts/widget/>
  - <https://developers.cloudflare.com/turnstile/plans/>
  - <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
  - <https://developers.cloudflare.com/turnstile/reference/content-security-policy/>
  - <https://www.cloudflare.com/turnstile-privacy-policy/>
  - <https://www.cloudflare.com/cloudflare-customer-dpa/>
  - Kesinti: <https://blog.cloudflare.com/18-november-2025-outage/>
- reCAPTCHA:
  - <https://docs.cloud.google.com/recaptcha/docs/faq>
  - <https://docs.cloud.google.com/recaptcha/docs/compare-tiers>
  - <https://docs.cloud.google.com/recaptcha/docs/migration-overview>
  - <https://developers.google.com/recaptcha/docs/v3>
  - <https://cloud.google.com/terms/data-processing-addendum>
  - <https://www.infoq.com/news/2026/05/cloud-fraud-defense-recaptcha/>
- hCaptcha: <https://www.hcaptcha.com/pricing>, <https://docs.hcaptcha.com/>
- W3C, CAPTCHA erişilebilirliği: <https://www.w3.org/TR/turingtest/>
- CNIL kararı:
  <https://www.hunton.com/privacy-and-cybersecurity-law-blog/cnil-issues-e125000-fine-against-e-scooter-rental-company>
- KVKK ve yurt dışına aktarım:
  - <https://www.mondaq.com/turkey/privacy-protection/1740066/kvkk-yurt-d%C4%B1%C5%9F%C4%B1na-veri-aktar%C4%B1m%C4%B1-rehberi-2026-g%C3%BCncel-d%C3%BCzenlemeler>
  - <https://www.esenyelpartners.com/tr/kvkk-cerez-rehberi-uyarinca-web-siteleri-icin-uyum-yol-haritasi/>
- reCAPTCHA v2 resim bulmacasının kırılması: <https://arxiv.org/pdf/2409.08831>

**Doğrulanamayanlar:**
- Cloudflare'in KVKK standart sözleşmesi imzalayıp imzalamadığı.
- reCAPTCHA'da faturalama hesabı yokken 10 bin sınırı aşılınca 429 dönmesi
  (yalnızca üçüncü taraf kaynakta var).
- Turnstile'ın AA mı AAA mı olduğu (Cloudflare'in iki sayfası çelişiyor).
- ALTCHA worker'larının Next 16 / Turbopack ile paketlenmesi.
