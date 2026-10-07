# Masaüstü imzalama ve kurulum ekranı araştırması — 2026-10-07

Soru: Sahip Windows yükleyicisini indirince "Windows protected your PC /
bilinmeyen yayıncı" uyarısı aldı. "Bunu nasıl çözeriz? Ücretsiz lisans
(sertifika) alamaz mıyız? Ya da kurulum ekranını daha modern yapamaz mıyız?"

Köşeli parantezli numaralar en alttaki kaynaklara gider.

## Karar

**Uyarıyı hem ücretsiz hem hemen kaldıran bir yol yok. Bugün çalışan en ucuz
çözüm Certum'un Open Source sertifikası (49 €'dan başlıyor). Ücretsiz yollar ya
şimdilik kapalı ya da yalnızca belli kanallarda işe yarıyor.**

- **SignPath Foundation (ücretsiz):** Başvurulmalı, ama bugün kabul
  beklenmemeli. Vakıf, çalıştırılabilir programlar için "doğrulanabilir itibar"
  istiyor [9]. Eylül 2026'da bir projeyi "yerleşik kullanıcı tabanı yok" diye
  reddetti [11]. LobbyForge'un 2 yıldızı var; son beş sürümde toplam 28 indirme
  oldu (GitHub API, 2026-10-07). Kabul edilirse yayıncı adı "SignPath
  Foundation" görünür.
- **Azure Artifact Signing (eski adı Trusted Signing):** Türkiye'den
  kullanılamıyor. Bireyler yalnızca ABD veya Kanada'da olabiliyor. Kuruluşlara
  açık ülke listesinde de Türkiye yok [6].
- **Certum Open Source:** Türkiye'deki bir birey alabiliyor. Sertifikada
  sahibin adı "Open Source Developer" ibaresiyle görünür. Yazılım ticari olarak
  dağıtılırsa sertifika iptal edilir [12].
- **Microsoft Store (MSIX):** Bireysel geliştirici hesabı ücretsiz [16]. Store,
  MSIX paketini kendisi imzaladığı için SmartScreen uyarısı çıkmaz [1]. Ancak bu
  yalnızca Store'dan kuranlar için geçerli. Tauri 2 MSIX üretmiyor; bunun için
  bir topluluk aracı ya da Microsoft'un winapp CLI'ı gerekiyor [18][19].
- **winget:** Ücretsiz bir ek kanal. İmza şartı yok. winget ile kurulan dosya
  genelde SmartScreen'e takılmıyor; bu, Microsoft dokümanından değil winget
  kaynak kodundan çıkarılan bir sonuç [20]. İmzasız dosyayı Smart App Control
  yine de engeller [3].
- **Kendi imzaladığımız (self-signed) sertifika:** İşe yaramaz. Windows bunu
  imzasız dosya gibi değerlendirir [2].
- **İmza da uyarıyı bir anda bitirmez.** Yeni imzalanmış bir dosya da itibar
  birikene kadar uyarı alır. Bu "birkaç hafta ve yüzlerce temiz kurulum"
  sürebilir. Farkı şu: uyarıda yayıncı adı görünür ve Smart App Control dosyayı
  engellemez [2][3]. EV sertifikası 2024'ten beri bu bekleme süresini
  atlatmıyor [1].
- **Kurulum ekranının görünüşü imzadan bağımsız.** Güzel bir yükleyici de
  imzasızsa uyarı alır. Tauri'nin NSIS yükleyicisi markalanabilir. Özel bir
  şablonla Discord'unki gibi tek tıklık hale de getirilebilir: sihirbaz yok,
  kullanıcı klasörüne kurar, bitince uygulamayı açar. Bunu lead, sahibe
  ihtiyaç duymadan yapabilir.
- **macOS:** Ücretsiz bir yol yok. Developer ID ve notarization için Apple
  Developer Program'a üyelik gerekiyor; yıllık ücret 99 $. Bireylere ücret
  muafiyeti yok [21]. Mac kullanıcıları geldiğinde alınmalı.
- **Linux:** İşletim sistemi düzeyinde imza gerekmiyor. GPG imzası isteğe
  bağlı [22][23].

## Uyarı neden çıkıyor

Burada iki ayrı şey var:

1. **Authenticode imzası.** Dosyanın kimden geldiğini ve sonradan
   değiştirilmediğini kanıtlar. Güvenilir bir sertifika otoritesinden (CA)
   alınan sertifikayla yapılır.
2. **SmartScreen itibarı.** Microsoft, hem dosya hash'i hem de imzalayan
   sertifika için bir indirme geçmişi tutar. Bu itibar bilinmiyorsa ya da
   olumsuzsa, dosya imzalı olsa bile uyarı çıkar [2][4].

**Mark-of-the-Web (MOTW):** Tarayıcı internetten indirilen dosyaya bir
`Zone.Identifier` akışı ekler: `ZoneId=3`, yani Internet bölgesi.
SmartScreen'in denetlediği dosyalar bunlardır. Dosya Özellikleri'ndeki
"Engellemeyi kaldır" kutusu ya da `Unblock-File` bu işareti siler [5].

**Kullanıcının ilk indirmede gördüğü:**

| Durum | Ne görünür | Kaynak |
|---|---|---|
| İmzasız (bugünkü durum) | "Windows protected your PC". Kullanıcı "More info → Run anyway" demek zorunda. Kurum politikası çalıştırmayı tamamen engelleyebilir. Smart App Control açıksa dosya engellenir ve bunu tek tek dosya için aşmanın yolu yok. | [2][3] |
| Self-signed | İmzasızla aynı | [2] |
| İmzalı ama yeni (OV, Certum, SignPath, Artifact Signing) | Yine "tanınmayan uygulama" uyarısı çıkar, ama **doğrulanmış yayıncı adı** görünür. Smart App Control buna izin verir. | [2][3] |
| İmzalı ve itibarı oluşmuş | Uyarı çıkmaz. Aynı kimlikle imzalanan yeni sürümler bu itibarı devralabilir. | [2] |
| Microsoft Store'dan kurulum | Uyarı çıkmaz | [1][2] |

**Bilinmesi gerekenler:**
- İmzasız her yeni sürüm itibara sıfırdan başlar [2].
- Sertifika değiştirmek yayıncı itibarını etkiler. Tek bir imza kimliği
  seçilip ona sadık kalınmalı [2].
- Tüketici bilgisayarları için itibar incelemesine dosya göndermenin yolu yok.
  İtibar indirme sayısıyla kendiliğinden birikir [2].
- Smart App Control bilinmeyen imzasız kodu engeller. Microsoft'un servisi
  dosya hakkında karar veremediğinde bile, Trusted Root Program'daki bir CA
  tarafından imzalanmış dosyanın çalışmasına izin verir [3].

## Bugünkü durum (repo)

- **`tauri.conf.json`:**
  - `bundle.windows` bölümü yok, yani imza ayarı da yok.
  - `publisher: "LobbyForge"` ürün adıyla aynı. Tauri'nin Store rehberi buna
    izin vermiyor [18].
  - `targets: "all"`.
  - NSIS varsayılan ayarlarda: kurulum türü `currentUser` ve uygulama
    `%LOCALAPPDATA%\LobbyForge` klasörüne kuruluyor [22].
  - WebView2 varsayılan ayarda: `downloadBootstrapper`.
- **Tauri updater kullanılmıyor.**
  - `Cargo.toml`'da `tauri-plugin-updater` yok.
  - `plugins.updater` ayarı yok.
  - `apps/desktop/src/index.ts`'teki DP-04 notu, `autoUpdate` bayrağının bu
    yüzden kaldırıldığını söylüyor.
- **Windows sürümü iki ayrı yerde derleniyor:**
  - `desktop-release.yml`: tauri-action ile, `desktop-v*` etiketiyle.
    `main`'de v0.6.2; deps-cleanup çalışması v1.0.0'a yükseltiyor.
  - `release.yml` içindeki `desktop` işi: `tauri build --bundles nsis`.
    MSI ön sürüm numarasını (`rc`) kabul etmediği için yalnızca NSIS
    üretiyor.

  İmza ya ikisine birden eklenmeli ya da tek bir yola indirilmeli.
- **Mevcut kararlar ve metinler:**
  - ADR-005 imzayı "dağıtım öncesine" erteledi.
  - İndirme sayfasında dürüst bir "imzasız beta" notu var
    (`hub.download.unsigned.*`).
- **MSI her zaman yönetici izni ister.** Şablonda `InstallScope="perMachine"`
  sabit [22]. İmzasız olduğu için UAC penceresinde de bilinmeyen yayıncı
  görünür.
- **Küçük bir uyumsuzluk:** Smoke testi uygulamayı önce
  `%LOCALAPPDATA%\Programs\LobbyForge` altında arıyor. Tauri ise
  `%LOCALAPPDATA%\LobbyForge` altına kuruyor. Test, yedek aramasıyla yine de
  buluyor.
- **Karıştırılmaması gereken anahtar:** `LF_RELEASE_SIGNING_KEY` sunucu sürüm
  manifestini imzalayan Ed25519 anahtarı. İşletim sistemi imzasıyla ilgisi
  yok.

## Windows seçenekleri

| Seçenek | 2026 fiyatı | Türkiye'deki bir bireye açık mı? | Görünen yayıncı | CI | Not |
|---|---|---|---|---|---|
| SignPath Foundation | Ücretsiz [9] | Açık, ama itibar şartı var; bugün büyük olasılıkla ret [9][11] | "SignPath Foundation" [9] | GitHub Actions, kaynak doğrulamalı [10] | Her sürüm elle onaylanır [9] |
| Azure Artifact Signing | Basic ~9,99 $/ay, 5.000 imza [1][8] | **Hayır.** Bireyler yalnız ABD/Kanada [6] | Doğrulanmış ad [7] | Var, donanım token'ı gerekmez [1] | Ücretli Azure aboneliği şart [7] |
| Certum Open Source (SimplySign) | 49 €'dan [12] | **Evet**, yalnızca bireyler [12] | "Open Source Developer" ve ad [12] | Topluluk araçlarıyla; TOTP sırrı gerekir [14] | Ticari dağıtımda iptal; ayda 5.000 imza [12] |
| OV/IV (ör. SSL.com) | 129 $/yıl, üstüne eSigner 15 $/ay veya YubiKey 379 $ [15]. Microsoft'un aralığı 150–300 $/yıl [1] | Evet | Ad veya şirket | eSigner ile [15] | Anahtar HSM'de veya token'da [1] |
| EV | 400 $ ve üstü/yıl [1] | Genelde şirkete | Şirket | HSM | 2024'ten beri SmartScreen'de OV'den farkı yok [1][2] |
| Store — MSIX | Hesap ücretsiz [16], imza ücretsiz [1] | Evet; yaklaşık 200 pazar, kimlik ve selfie [16] | Store'daki yayıncı | MSIX'i biz üretiriz | SmartScreen yok [1]; Tauri MSIX üretmiyor [18][19] |
| Store — Win32 EXE/MSI | Hesap ücretsiz; sertifika bizim [1][17] | Evet | Bizim sertifikamız | — | Kendi imzamız şart [17] |
| winget | Ücretsiz [20] | Evet | Yükleyicideki imza | PR ile | İmza şartı yok [20] |
| Self-signed | Ücretsiz | — | — | — | İmzasızla aynı uyarı [1][2] |

### SignPath Foundation

- **Koşullar** [9]:
  - OSI onaylı bir lisans ve hiçbir bileşende ticari çift lisans olmaması.
    LobbyForge yalnızca AGPL ile lisanslı, bu yüzden uygun. İleride ticari
    lisans eklenirse uygunluk biter.
  - Projede hiç kapalı kaynak bileşen olmaması.
  - Projenin aktif olarak bakılıyor ve zaten yayımlanmış olması.
  - İndirme sayfasında ne işe yaradığının anlatılması.
  - Kaldırma (uninstall) desteği.
  - Uygulama kullanıcı verisini kullanıcının seçmediği sistemlere gönderiyorsa
    gizlilik politikası. LobbyForge yalnızca kullanıcının girdiği sunucuya
    bağlanıyor.
- **Ekip kuralları** [9]:
  - Herkeste çok faktörlü kimlik doğrulama (MFA).
  - Author, Reviewer ve Approver rolleri.
  - Ana sayfada bir "Code signing policy" bölümü. Bu bölümde şunlar olmalı:
    "Free code signing provided by SignPath.io, certificate by SignPath
    Foundation" cümlesi, roller ve bir gizlilik cümlesi.
- **İtibar şartı:** Vakfın kendi sözleri: "For executable programs … we require
  a certain verifiable reputation" [9]. Vakfın kabul etmek gibi bir
  zorunluluğu da itiraz mekanizması da yok [9].
- **GitHub entegrasyonu** [10]:
  - Kullanılan action: `signpath/github-action-submit-signing-request@v3`.
  - İmzalanacak dosya önce `actions/upload-artifact@v4+` ile workflow
    artefaktı olarak yüklenmeli.
  - Açık kaynak projelerde imzaya giden tüm işler GitHub'ın kendi
    runner'larında çalışmalı.
  - İsteğe bağlı politikalar: `disallow_reruns` ve
    `runners.required_github_hosted`.
- **Desteklenen biçimler:** PE, MSI, ZIP gibi biçimler destekleniyor ve MSI'ın
  içindeki dosyalar da imzalanıyor. NSIS yükleyicisi listede yok [10]. Bunun
  sonucu aşağıdaki "Tauri'ye bağlama" bölümünde.
- **Süre:**
  - Resmî bir onay süresi yayımlanmıyor.
  - Kabulden sonraki kurulum yaklaşık 15 dakika sürüyor [11].
  - Önce bir test sertifikası veriliyor. Üretim sertifikası SignPath ekibi
    kurulumu inceledikten sonra geliyor. Gerçek bir Tauri projesi Ağustos
    2026'da hâlâ "CSR PENDING" durumunda bekliyordu [11].
- **Artısı:** Sahibin adı sertifikada görünmez.
- **Eksileri:** Her sürüm elle onaylanır. Vakıf kurallar çiğnenirse sertifikayı
  hemen ya da geriye dönük iptal edebilir [9].

### Azure Artifact Signing

- **Ad:** Trusted Signing'in yeni adı Artifact Signing [1].
- **Fiyat:** Basic katmanında ayda 5.000, Premium'da 100.000 imza var [8].
  Resmî fiyat sayfası tutarı göstermiyor ("$-"). ~9,99 $/ay rakamı Microsoft
  Learn sayfalarından [1][2].
- **Uygunluk** (Public Trust sertifikası) [6]:
  - Kuruluşlar: ABD, Kanada, AB, Birleşik Krallık, Avustralya, Yeni Zelanda,
    Japonya, Güney Kore, Singapur, İsviçre, Norveç ve İsrail.
  - Bireyler: yalnızca ABD ve Kanada.
  - Türkiye listede yok. Hizmet ne birey ne de şirket olarak kullanılabiliyor.
- **Diğer koşullar:**
  - Ücretsiz, deneme ya da sponsorlu Azure aboneliğiyle çalışmıyor [7].
  - Kimlik doğrulaması 1–20 iş günü sürüyor [6].
  - EV sertifikası vermiyor [7].
  - SmartScreen'de anında güven sağlamıyor [1].
- **Dikkat:** Velopack'in dokümanı "instant SmartScreen reputation" sağladığını
  yazıyor [24]. Bu Microsoft'un kendi sayfalarıyla çelişiyor; Microsoft esas
  alınmalı.

### Certum Open Source

- **Ürünler** [12]:
  - "Open Source Code Signing in the Cloud" (SimplySign bulutu): 49 €'dan.
  - Kart ve okuyuculu set: 69 €'dan; sayfada "stokta yok" görünüyor.
- **Koşullar** [12]:
  - Yalnızca bireylere veriliyor.
  - Kimlik doğrulaması gerekiyor: otomatik, kayıt noktasında ya da noter
    onayıyla.
  - Adına düzenlenmiş bir fatura (adres kanıtı) isteniyor.
  - Kişinin projeyle ilişkisini açıkça gösteren, herkese açık bir açık kaynak
    proje adresi isteniyor.
- **Sertifikada görünen** [12]: Common Name alanına "Open Source Developer"
  ibaresi ekleniyor, Organization alanı da "Open Source Developer" oluyor.
- **Ticari kullanım** [12]: Sertifika ticari olarak dağıtılan bir yazılımı
  imzalamakta kullanılırsa iptal edilir.
- **Geçerlilik süresi:**
  - Certum, 27 Şubat 2026'dan beri tek bir sertifikayı en çok 459 gün
    geçerli veriyor. 2 ya da 3 yıllık ürünlerde ara sıra ücretsiz yeniden
    düzenleme gerekiyor [12].
  - CA/B Forum'un CSC-31 kararıyla 1 Mart 2026'dan beri üst sınır 460 gün
    [13].
- **Bulut kotası:** Ayda en çok 5.000 imza [12].
- **CI'da kullanım:** SimplySign'a mobil uygulamanın ürettiği TOTP koduyla
  giriliyor. Otomatikleştirmek için topluluk çözümleri var:
  - TOTP sırrını kurulumdaki QR kodundan çıkarıp girişi otomatik yapmak [14].
  - Windows runner'a SimplySign Desktop'ı kurup giriş yapan bir Action [14].
  - SimplySign Desktop gerektirmeyen, yalnızca HTTPS kullanan `ssign` aracı
    [14].

  Bunların hepsi küçük topluluk projeleri. TOTP sırrı uzun ömürlü bir anahtar
  gibidir; korumalı bir GitHub Environment secret'ında tutulmalı.
- **CI'sız seçenek:** Sürüm günü sahip kendi Windows makinesinde SimplySign
  Desktop açıkken `tauri build` çalıştırır. Tauri sertifikanın thumbprint'iyle
  imzalar.
- **Zaman damgası sunucusu:** `http://time.certum.pl` [14].

### Normal OV ve EV sertifikaları

- **Microsoft'un verdiği fiyatlar** [1]:
  - OV: yılda 150–300 $.
  - EV: yılda 400 $ ve üstü.
  - Haziran 2023'ten beri özel anahtarın bir HSM'de ya da donanım token'ında
    durması zorunlu.
- **Örnek, SSL.com** [15]:
  - OV: 1 yıllık 129 $.
  - YubiKey token: +379 $.
  - eSigner bulut imzası: ayda 15 $, 240 imza.
  - Şirketi olmayan bireyler için ayrı bir "IV" ürünü var.
- **Değerlendirme:** Türkiye'den alınabilir. Ama Certum Open Source'tan birkaç
  kat pahalı ve SmartScreen'de bir avantajı yok [1].

### Microsoft Store

- **Hesap** [16]:
  - Bireysel hesap ücretsiz; eski 19 $'lık ücret kaldırıldı.
  - Kimlik belgesi ve selfie ile doğrulama yapılıyor.
  - Yaklaşık 200 pazarda açık.
  - Ücretsiz akış yalnızca `storedeveloper.microsoft.com` üzerinden
    başlatılabiliyor.
- **MSIX ile:** Store paketi yeniden imzalar. Sertifika gerekmez ve SmartScreen
  uyarısı çıkmaz [1].
- **Win32 EXE/MSI ile** [17]:
  - Store yükleyiciyi yeniden imzalamaz.
  - Yükleyici ve içindeki tüm PE dosyaları, Trusted Root Program'a zincirlenen
    bir sertifikayla imzalı olmalı.
  - Kurulum sessiz olmalı, internetten ek dosya indirmemeli.
  - Sürüme özgü, sonradan değişmeyen bir HTTPS indirme adresi verilmeli.
- **Tauri 2 ile durum** [18]:
  - Tauri yalnızca EXE ve MSI üretiyor. Store rehberi Win32 yolunu anlatıyor.
  - WebView2 için `webviewInstallMode: offlineInstaller` istiyor; bu yükleyiciyi
    yaklaşık 127 MB büyütüyor [22].
  - Yayıncı adı ürün adıyla aynı olamaz. Bizde ikisi de "LobbyForge".
- **MSIX üretmenin yolları** [19]:
  - Tauri'de MSIX desteği için açılan #4818 numaralı issue hâlâ açık.
  - Topluluk aracı `@choochmeque/tauri-windows-bundle`: Store'a hazır MSIX
    üretiyor; protokol işleyici ve mikrofon yeteneği tanımlanabiliyor.
  - Microsoft'un winapp CLI'ının Tauri rehberi şöyle diyor: "The Microsoft
    Store will sign the MSIX for you".
- **MSIX'te dikkat edilecekler** (hiçbiri test edilmedi):
  - Güncellemeleri Store yönettiği için Store sürümünde Tauri updater kapalı
    olmalı.
  - `lobbyforge://` derin bağlantısı paket manifestinde bildirilmeli.
  - Mikrofon, `device` yeteneği olarak eklenmeli.
- **Sonuç:** Store, Windows kullanıcıları için ücretsiz ve uyarısız bir kanal.
  Ama GitHub'dan indirilen `setup.exe` imzasız kalmaya devam eder.

### winget

- **Gönderim** [20]:
  - `microsoft/winget-pkgs` deposuna YAML manifesti içeren bir PR açılır.
  - Önce `winget validate` ve Sandbox testi yapılır.
  - Ardından otomatik doğrulama çalışır ve bir moderatör onaylar.
- **Koşullar** [20]:
  - `InstallerUrl` yayıncının kendi yayın yeri olmalı (GitHub Releases uygun);
    HTTPS olmalı ve yönlendirme içermemeli.
  - Kurulum sessiz yapılabilmeli. Uygulama hem yönetici olan hem olmayan bir
    kullanıcıyla kurulup kaldırılabilmeli.
  - SHA256 değeri tutmalı ve dosya antivirüs taramalarından geçmeli.
  - Gizlilik URL'si verilmeli.
  - Uygulamada kullanıcı içeriği (UGC) varsa kullanım koşulları ve bir şikâyet
    yolu olmalı. LobbyForge sohbet içerdiği için buna tabi.
  - İmza şartı yok.
- **SmartScreen ile ilişkisi:**
  - winget indirdiği dosyaya önce Internet bölgesi MOTW'si koyar.
  - Hash eşleşir ve kaynak "Trusted" ise (varsayılan `winget` kaynağı öyle
    işaretli) işareti `URLZONE_TRUSTED`'a çevirir [20].
  - Böylece SmartScreen'in baktığı Internet işareti kalkmış olur.
  - Bu bir kaynak kod çıkarımı; Microsoft'un dokümanında yazmıyor. 2023'te
    imzasız bir paket için bunun tersi bildirilmişti [20].
- Smart App Control imzasız dosyayı yine engeller [3].
- Tauri'nin NSIS yükleyicisi `/S` ile sessiz kurulumu destekliyor. Repo'daki
  smoke testi zaten bunu kullanıyor.

### Self-signed sertifika

Kullanıcı kök sertifikayı kendisi kurmadıkça Windows bu imzaya güvenmez.
SmartScreen ve Smart App Control dosyayı imzasız gibi değerlendirir [1][2][3].
Yalnızca test ortamında ya da sertifikayı merkezden dağıtabilen kurumlarda işe
yarar.

## macOS

- **Ücretsiz Apple hesabıyla** Developer ID, notarization ya da App Store dışı
  dağıtım yapılamıyor [21].
- **Apple Developer Program** yılda 99 $; Apple, olan yerlerde yerel para
  karşılığını da kabul ediyor [21].
- **Ücret muafiyeti** yalnızca kâr amacı gütmeyen kuruluşlara, akredite eğitim
  kurumlarına ve devlet kurumlarına veriliyor. Apple'ın şartı açık: "Not be an
  individual, sole proprietor, or single-person business". Yani bireyler ve
  açık kaynak projeler muafiyet alamıyor [21].
- **İmzasız ya da notarize edilmemiş bir uygulama:**
  - Sequoia'dan beri Control-click → Open ile açılamıyor. Kullanıcının System
    Settings → Privacy & Security → Open Anyway yolunu izlemesi gerekiyor
    [21].
  - Apple'ın 27 Mayıs 2026 tarihli destek sayfası hâlâ bu akışı anlatıyor.
    Kullanıcının gördüğü uyarı: "Apple cannot check … for malicious software"
    [21].
- **Ad-hoc imza** (`signingIdentity: "-"`) bu izin adımını ortadan kaldırmıyor
  [22].
- **Homebrew:** 5.0.0 sürümü (12 Kasım 2025) imzasız cask'leri kullanımdan
  kaldırdı. Gatekeeper kontrolünden geçmeyen cask'lerin Eylül 2026'da devre
  dışı bırakılacağını duyurdu ve `--no-quarantine` seçeneğini de kaldırdı
  [25]. Yani resmî cask için notarization şart.

## Linux

- İşletim sistemi düzeyinde zorunlu bir imza yok.
- **AppImage:**
  - Tauri şu değişkenlerle imzalıyor: `SIGN=1`, `SIGN_KEY`,
    `APPIMAGETOOL_SIGN_PASSPHRASE`, `APPIMAGETOOL_FORCE_SIGN`.
  - AppImage imzayı kendisi doğrulamıyor. Kullanıcının `validate` aracıyla
    elle bakması gerekiyor [22].
- **deb ve rpm:**
  - Paketler GPG ile imzalanabilir, ama asıl güven APT deposundan gelir.
  - Depoda ya imzalı bir `InRelease` dosyası ya da `Release` ile birlikte
    `Release.gpg` bulunur. `Signed-By` alanı hangi anahtarların kabul
    edileceğini belirler [23].
  - GitHub Releases'tan elle indirilen bir .deb'de imza denetimi yapılmaz.
- **Bugün:** `release.yml` her dosya için zaten SHA256 özeti üretiyor.
- **Flathub** [23]:
  - Uygulama tamamen kaynak koddan derlenmeli.
  - İzinler en aza indirilmeli; mümkün olan yerde portallar kullanılmalı.
  - Doğrulama için alan adı kontrolü gerekiyor
    (`/.well-known/org.flathub.VerifiedApps.txt`).
  - Uygulama kimliği ters DNS biçiminde olmalı.
  - Tauri'nin Flatpak rehberi .deb'den paketlemeyi gösteriyor [22]; bu,
    Flathub'ın kaynaktan derleme şartıyla çatışabilir.
  - Bizim kimliğimiz `dev.lobbyforge.desktop`. Bunun için `lobbyforge.dev`
    alan adının kontrolü gerekir.
- **Snap** [22]:
  - Ubuntu One hesabı ve `strict` kapsama (confinement) gerekiyor; izinler
    "plug"larla isteniyor.
  - Yayın komutu: `snapcraft upload --release=stable`.

## Tauri'ye bağlama

### Windows

- **Sertifika Windows sertifika deposundaysa** (Certum SimplySign Desktop ya da
  USB token):
  - Gereken ayarlar: `bundle.windows.certificateThumbprint`,
    `digestAlgorithm: "sha256"` ve `timestampUrl` [22].
  - Bu durumda Tauri uygulama exe'sini, NSIS yükleyicisini ve MSI'ı imzalar.
    NSIS'in kaldırıcısını da `!uninstfinalize` ile imzalar [22].
- **Başka bir imza aracı için `bundle.windows.signCommand`:**
  - `%1` imzalanacak dosyanın yoluyla değiştirilir. Komut düz metin ya da
    `{cmd, args}` biçiminde yazılabilir [22].
  - Artifact Signing örneği:
    `artifact-signing-cli -e https://wus2.codesigning.azure.net -a Account -c Profile -d AppName %1`
    [22].
  - SSL.com gibi TSP kullanan sağlayıcılarda `tsp: true` eklenir [22].
- **SignPath `signCommand` ile çalışmaz**, çünkü dosyanın workflow artefaktı
  olarak gelmesini şart koşar [10].
  - Akış şöyle: Tauri imzasız derler → dosya `upload-artifact` ile yüklenir →
    SignPath action'ı imzalar → imzalı dosya eskisinin yerine konur.
  - MSI'ın içi de imzalanır, NSIS'in içi imzalanamaz [10]. Gerçek bir Tauri
    projesi yalnızca dıştaki yükleyiciyi imzalıyor [11].
  - Her şeyi imzalamak için iki geçiş gerekir: önce `tauri build --no-bundle`
    ile exe derlenip SignPath'e gönderilir, sonra `tauri bundle` ile
    yükleyiciler üretilip yeniden gönderilir. Bu, sürüm başına iki onay demek.
  - Bu yolda kaldırıcı imzasız kalır. Smart App Control onu engelleyebilir.
- **Secret yoksa imzasız devam etmek:** İmza ayarları ayrı bir
  `tauri.signing.conf.json` dosyasına konur. CI bu dosyayı yalnızca secret
  tanımlıysa `--config` ile verir (tauri-action'da `args` üzerinden). Böylece
  fork'lar ve PR'lar etkilenmez.
- **tauri-action sürümü:** `main` dalında v0.6.2'ye sabitlenmiş. Güncel
  sürüm action-v1.0.0 (29 Haziran 2026) [22]. `chore/deps-cleanup` dalında
  henüz commit edilmemiş bir değişiklik bunu v1.0.0'a yükseltiyor. İmza
  adımları v1 üzerine kurulmalı.

### macOS

- **İmza için ortam değişkenleri:** `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`.
- **Notarization için iki yol** [22]:
  - App Store Connect API: `APPLE_API_ISSUER`, `APPLE_API_KEY`,
    `APPLE_API_KEY_PATH`.
  - Apple ID: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- tauri-action bu değişkenleri derlemeye aktarıyor.
- `entitlements.plist` ve `Info.plist` repo'da zaten hazır.

### Tauri updater

- **İşletim sistemi imzasından ayrı bir imza.** Zorunlu ve kapatılamıyor [22].
- **Kurulum adımları** [22]:
  - Anahtar çifti `tauri signer generate` ile üretilir.
  - Özel anahtar `TAURI_SIGNING_PRIVATE_KEY` (ve isteğe bağlı
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) secret'ı olarak verilir.
  - Ayarlara `bundle.createUpdaterArtifacts: true`, `plugins.updater.pubkey` ve
    `plugins.updater.endpoints` eklenir.
  - GitHub için güncelleme listesi `latest.json` dosyasıdır. tauri-action bunu
    `uploadUpdaterJson` ile yükler; bu seçenek varsayılan olarak açık.
  - Windows'ta güncelleme kipi (`installMode`) `passive` (varsayılan),
    `basicUi` ya da `quiet` olabilir.
- **Bugün kullanılmıyor** (yukarıdaki "Bugünkü durum" bölümüne bakın).
- **Anahtar kaybolursa** kurulu kullanıcılara bir daha güncelleme
  gönderilemez [22].
- `LF_RELEASE_SIGNING_KEY` ile aynı anahtar kullanılmamalı.
- Updater imzası SmartScreen'i etkilemez; yükleyici yine Authenticode imzası
  ister.

## Daha modern kurulum ekranı

### NSIS'te yalnızca ayarlarla yapılabilenler (`bundle.windows.nsis`)

| Alan | Ne yapar | Not |
|---|---|---|
| `installMode` | `currentUser`: `%LOCALAPPDATA%\LobbyForge`, yönetici izni yok. `perMachine`: Program Files, yönetici izni ister. `both`: kullanıcıya seçtirir, yönetici izni ister. | Varsayılan `currentUser`; ayarda açıkça yazılmalı [22] |
| `headerImage` | Sayfaların üst bandı | BMP, önerilen 150×57 [22] |
| `sidebarImage` | Hoş geldin ve Bitiş sayfalarının yan görseli | BMP, önerilen 164×314 [22] |
| `installerIcon`, `uninstallerIcon` | Yükleyici ve kaldırıcı ikonu | .ico; repo'da `icons/icon.ico` var |
| `uninstallerHeaderImage` | Kaldırıcının üst bandı | BMP, 150×57 [22] |
| `languages` | Örnek: `["English", "Turkish"]`; varsayılan olarak işletim sisteminin dili seçilir | Tauri'nin kendi metinleri için `Turkish.nsh` var [22] |
| `displayLanguageSelector` | Kurulumdan önce dil seçme penceresi | `false` önerilir; dil otomatik seçilir |
| `customLanguageFiles` | Tauri metinlerinin çevirisi | .nsh dosyası [22] |
| `compression` | `lzma` (varsayılan), `bzip2`, `zlib` ya da `none` | [22] |
| `startMenuFolder` | Başlat menüsünde klasör | [22] |
| `installerHooks` | Ön/son kurulum ve ön/son kaldırma makroları | Sayfa akışını değiştiremez [22] |
| `template` | Tamamen özel bir .nsi dosyası | Aşağıya bakın |

**Diğer ayarlar ve seçenekler:**
- `bundle.licenseFile` NSIS'e ve MSI'a bir lisans sayfası ekler.
  `windows.webviewInstallMode` WebView2'nin nasıl kurulacağını seçer [22].
- **Komut satırı seçenekleri** [22]:
  - `/S`: sessiz kurulum.
  - `/P`: pasif kurulum. Sihirbaz sayfaları atlanır, yalnızca ilerleme
    görünür.
  - `/R`: kurulum bitince uygulamayı açar (yalnızca `/S` ya da `/P` ile
    birlikte).
  - `/NS`: kısayol oluşturmaz.
  - `/UPDATE`: güncelleme kipi.
- **Varsayılan sayfa akışı** [22]:
  1. Hoş geldin
  2. Lisans (tanımlıysa)
  3. Kurulum türü (`both` ise)
  4. Önceki kurulum bulunursa yeniden kur/kaldır seçimi
  5. Klasör
  6. Başlat menüsü
  7. Kurulum
  8. Bitiş ("Çalıştır" ve "Masaüstü kısayolu" kutuları)

### WiX/MSI

- **Görseller** [22]:
  - `bannerPath`: BMP, 493×58 zorunlu. İlk sayfa dışındaki sayfaların üstünde
    görünür.
  - `dialogImagePath`: BMP, 493×312 zorunlu. Hoş geldin ve bitiş
    pencerelerinde görünür.
- **Lisans sayfası:** `licenseFile` ile eklenir. Dosya .rtf değilse Tauri onu
  RTF'e çevirir [22].
- **Diğer ayarlar:** `language` (her dil için ayrı bir MSI üretir), `template`
  ve `fragmentPaths` [22].
- **Sınırlar:**
  - MSI her zaman makine geneline kurulur, yani UAC çıkar.
  - Sürüm numarası `major.minor.patch.build` biçiminde ve sayısal olmalı.
    `rc` gibi ön sürüm etiketleri bu yüzden olmuyor [22].
- **Öneri:** MSI kurumsal dağıtım için ikinci bir indirme seçeneği olarak
  kalsın. Ana indirme NSIS olsun.

### Discord tarzı tek tık kurulum

| Yol | Nasıl | Efor | Risk |
|---|---|---|---|
| 1. Yalnızca ayarlar | Yukarıdaki görseller ve diller | S | Hâlâ 5–6 sayfalık bir sihirbaz |
| 2. **Özel NSIS şablonu** (önerilen) | Tauri'nin `installer.nsi` dosyası kopyalanır ve iki yer değiştirilir. Pasif kip varsayılan yapılır. Kurulum bitince uygulama `/R` beklenmeden açılır. | M (1–2 gün + test) | Şablon Tauri sürümleriyle değişir. CLI sürümü sabitlenmeli, her yükseltmede fark kontrol edilmeli. |
| 3. Şablona nsDialogs ile büyük bir marka sayfası | nsDialogs, NSIS'in kendi aracı | M | Pencere boyutu MUI2 ile sabit |
| 4. Velopack | `vpk pack` ile bir `Setup.exe` üretilir. Sihirbaz yok, `%LocalAppData%\{packId}` altına kurar, yönetici izni istemez. Kurulum sırasında GIF, PNG ya da JPEG açılış görseli gösterir, bitince uygulamayı açar. `--framework webview2` ile WebView2'yi kurar, `--signTemplate` ile imzalar [24]. | L | Tauri'nin paketleyicisinin ve updater'ının yerini alır. Uygulamaya Velopack Rust SDK'sı eklenir. Tauri için resmî bir rehber yok. |
| 5. Kendi Rust bootstrapper'ımız | Küçük bir pencere ve içine gömülü kurulum dosyaları | L | Kaldırma, güncelleme, WebView2 ve onarımın hepsi bize kalır. Önerilmez. |

**2. yolun ayrıntısı:** Tauri şablonundaki Hoş geldin, yeniden kurulum, Klasör,
Başlat menüsü ve Bitiş sayfalarının hepsi pasif kipte zaten atlanıyor. Pasif
kipte pencere otomatik kapanıyor ve masaüstü kısayolu da kendiliğinden
oluşuyor [22]. Geriye yalnızca markalı başlık bandıyla küçük bir ilerleme
penceresi kalıyor. Gereken değişiklikler:

```nsis
; .onInit içinde, Tauri'nin /P okumasından hemen sonra:
StrCpy $PassiveMode 1            ; sihirbaz sayfalarını atla

; .onInstSuccess içinde, /R şartını beklemeden:
nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
```

Kapalı kaynak NSIS "skin" eklentilerinden kaçınılmalı. SignPath'in "kapalı
kaynak bileşen olmayacak" şartına takılır [9].

### Görsel boyutları ve biçimleri

| Varlık | Boyut | Biçim | Kaynak |
|---|---|---|---|
| NSIS başlık bandı | 150×57 | BMP | [22] |
| NSIS yan görseli | 164×314 | BMP | [22] |
| NSIS ikonları | birden çok boyut | .ico | repo'da `icons/icon.ico` |
| WiX başlık bandı | 493×58 | BMP | [22] |
| WiX diyalog görseli | 493×312 | BMP | [22] |
| Velopack açılış görseli | serbest | GIF, PNG, JPEG | [24] |
| MSIX varlıkları | StoreLogo, Square44x44, Square150x150, Wide310x150 | PNG | [19]; Wide dışındakiler repo'da `tauri icon` çıktısı olarak var |
| DMG arka planı | serbest | PNG, JPG, GIF | [22] |

**Unutulmamalı:** Bunların hiçbiri SmartScreen'i etkilemez. Uyarıyı yalnızca
imza ve itibar belirler [2].

## Öneri: şimdi ve sonra

Efor ölçüsü: S ≤ 1 gün, M 2–5 gün, L 1–2 hafta.

| # | Adım | Kim yapar | Efor | Maliyet |
|---|---|---|---|---|
| 0 | İndirme sayfasını ve README'yi güncelle: SmartScreen için "More info → Run anyway", macOS için "Open Anyway" talimatı, SHA256 doğrulaması | Lead | S | 0 |
| 1 | NSIS'i markala: başlık ve yan görsel, ikon, `languages: ["English","Turkish"]`, `installMode: "currentUser"` açıkça; MSI'ı ikinci plana al | Lead | S | 0 |
| 2 | "Code signing policy" ve gizlilik sayfasını yaz (SignPath'in şartı; Store ve winget için de gerekli) | Lead | S | 0 |
| 3 | SignPath Foundation'a başvur | **Sahip** (GitHub kimliği, MFA) | S + bekleme | 0 |
| 4 | Certum Open Source (SimplySign) satın al ve kimlik doğrulamasını yap | **Sahip** (kimlik, ödeme) | S + bekleme | 49 €'dan |
| 5 | CI'a imzayı ekle: secret varsa devreye giren `--config` ve `certificateThumbprint`; iki Windows derleme yolunu tek yola indir | Lead; secret'ları sahip girer | M | 0 |
| 6 | Tek tık NSIS şablonu: varsayılan pasif kip, markalı ilerleme penceresi, bitince otomatik açılış | Lead | M | 0 |
| 7 | Microsoft Store: MSIX paketleme, protokol ve mikrofon yetenekleri, updater'ı kapalı bir Store sürümü | Lead (M); hesabı açıp göndermek **sahip** (S) | M | 0 |
| 8 | Bir imzalı sürüm çıktıktan sonra winget manifest PR'ı | Lead | S | 0 |
| 9 | Tauri updater: anahtar, `latest.json`, eklenti | Lead; özel anahtarı sahip saklar | M | 0 |
| 10 | macOS için Developer ID ve notarization, Mac kullanıcıları gelince | **Sahip** 99 $/yıl; Lead M | M | 99 $/yıl |
| 11 | Linux: AppImage GPG imzası; talep olursa Flathub veya Snap | Lead; hesaplar sahipte | M–L | 0 |

**Hangi sertifika?**
- Kapalı beta sürerken SignPath'in yanıtı beklenebilir. Herkese açık dağıtım
  yaklaşırsa ya da başvuru reddedilirse Certum alınmalı.
- İkisi birden alınırsa biri seçilip ona sadık kalınmalı. İtibar imzalayan
  kimliğe bağlı [2].
- Sahip adının sertifikada görünmesini istemiyorsa tek seçenek SignPath.
  Certum'da adı görünür.

**Sahip için kısa adımlar:**
1. GitHub'da iki adımlı doğrulamayı açık tut. Lead "Code signing policy"
   sayfasını hazırlayınca <https://signpath.org/apply> adresinden başvur.
2. Certum'u alacaksan "Open Source Code Signing in the Cloud" ürününü seç.
   Kimlik doğrulaması için kimlik fotoğrafı, adına bir fatura ve repo adresi
   gerekecek. SimplySign mobil uygulamasını kur. QR kodundaki TOTP sırrını
   yalnızca GitHub'daki `release` Environment'ına secret olarak koy; başka
   hiçbir yerde saklama.
3. <https://storedeveloper.microsoft.com> adresinden bireysel hesap aç
   (kimlik belgesi ve selfie). Yayıncı adı ürün adıyla ("LobbyForge") aynı
   olmasın.
4. Secret'ları gir: SimplySign için olanlar şimdi; ileride
   `TAURI_SIGNING_PRIVATE_KEY` ve `APPLE_*`.
5. SignPath kullanılırsa her sürümde e-postayla gelen imza isteğini onayla.
6. Mac için talep gelince Apple Developer Program'a katıl (yılda 99 $).

## Riskler

- **Beklenti yönetimi.** İmzadan sonra da birkaç hafta uyarı görülebilir [2].
  Duyuruda bu açıkça söylenmeli.
- **TOTP sırrının sızması.** Sızarsa başkası sahip adına imza atabilir.
  Korumalı Environment ve zorunlu onaycı kullanılmalı; sızıntı olursa
  SimplySign QR kodu yenilenmeli [14].
- **Kişisel ad.** Certum'da sahibin adı herkese görünür.
- **SignPath'in koşulları.** Vakıf sertifikayı iptal edebilir [9]. Ticari bir
  lisansla bağdaşmaz.
- **Özel NSIS şablonu** Tauri yükseltmelerinde bozulabilir.
- **MSIX'te test edilmeyenler.** Derin bağlantı, global kısayol, sistem
  tepsisi ve tek kopya (single-instance) davranışı MSIX'te denenmedi.
- **Sertifika yenileme.** Sertifikalar en çok 460 gün geçerli. Yenilemenin
  itibarı nasıl etkilediği doğrulanamadı.

## Kaynaklar

1. Microsoft Learn, "Code signing options for Windows app developers"
   (2026-08-29):
   <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>
2. Microsoft Learn, "SmartScreen reputation for Windows app developers"
   (2026-05-04, güncelleme 2026-08-17):
   <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
3. Microsoft Learn, "Smart App Control" (2026-09-30):
   <https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview>
4. Microsoft Learn, "Microsoft Defender SmartScreen overview" (2026-04-23):
   <https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/>
5. Microsoft Learn, "Mark of the Web and zones" (2026-07-17):
   <https://learn.microsoft.com/en-us/microsoft-365-apps/security/internet-macros-blocked>
6. Microsoft Learn, "Quickstart: Set up Artifact Signing" (2026-05-21):
   <https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
7. Microsoft Learn, "Artifact Signing FAQ" (2026-05-14):
   <https://learn.microsoft.com/en-us/azure/artifact-signing/faq>
8. Azure, Artifact Signing fiyatları:
   <https://azure.microsoft.com/en-us/pricing/details/artifact-signing/>
9. SignPath Foundation: <https://signpath.org/>,
   koşullar <https://signpath.org/terms>, başvuru <https://signpath.org/apply>
10. SignPath dokümanları:
    - <https://docs.signpath.io/trusted-build-systems/github>
    - <https://docs.signpath.io/artifact-configuration/reference>
11. Gerçek başvuru örnekleri:
    - Ret, 2026-09-16: <https://github.com/wslkit/skrog/issues/358>
    - Kurulum ~15 dk, yayıncı "SignPath Foundation", 2026-10-05:
      <https://github.com/camster91/Rclicker/issues/14>
    - SignPath kullanan bir Tauri projesi, test sertifikası → üretim:
      <https://github.com/fjrevoredo/mini-diarium/blob/main/docs/releasing/RELEASING.md>
12. Certum:
    - <https://shop.certum.eu/open-source-code-signing-on-simplysign.html>
    - <https://shop.certum.eu/open-source-code-signing.html>
    - <https://support.certum.eu/en/code-signing-required-documents/>
13. CA/B Forum Ballot CSC-31:
    <https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction/>
14. Certum'u CI'da kullanmak:
    - <https://www.devas.life/how-to-automate-signing-your-windows-app-with-certum/>
      (2025-07-11)
    - <https://github.com/jay0lee/certum-cloud-code-sign>
    - <https://github.com/Le-Syl21/ssign>
    - Zaman damgası adresi:
      <https://www.msz.it/a-cheap-code-signing-certificate-for-open-source-projects-by-certum-asseco-an-honest-review-walkthrough/>
15. SSL.com:
    - <https://www.ssl.com/products/software-integrity/code-signing/ov/>
    - <https://www.ssl.com/products/software-integrity/signing-service/>
16. Microsoft Store'da ücretsiz bireysel kayıt:
    - <https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer>
    - <https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/>
17. Microsoft Learn, MSI/EXE paket şartları:
    <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements>
18. Tauri, Microsoft Store rehberi: <https://v2.tauri.app/distribute/microsoft-store/>
19. Tauri için MSIX:
    - <https://github.com/tauri-apps/tauri/issues/4818>
    - <https://github.com/Choochmeque/tauri-windows-bundle>
    - <https://github.com/microsoft/winappCli/blob/main/docs/guides/tauri.md>
20. winget:
    - Gönderim: <https://learn.microsoft.com/en-us/windows/package-manager/package/repository>
    - Politikalar: <https://learn.microsoft.com/en-us/windows/package-manager/package/windows-package-manager-policies>
    - Kaynak kod, `UpdateInstallerFileMotwIfApplicable` işlevi:
      <https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerCLICore/Workflows/DownloadFlow.cpp>
      ve kaynak güven düzeyi
      <https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerRepositoryCore/SourceList.cpp>
    - Aksi bildirim, 2023: <https://github.com/vim/vim-win32-installer/issues/319>
    - <https://markdownmonster.west-wind.com/blog/posts/2026/Jun/01/Windows-Protected-your-PC-Dealing-with-Windows-SmartScreen-on-Installation>
21. Apple:
    - <https://developer.apple.com/support/compare-memberships/>
    - <https://developer.apple.com/programs/whats-included/>
    - <https://developer.apple.com/support/membership-fee-waiver/>
    - Sequoia'daki Gatekeeper değişikliği (2024-08-06):
      <https://developer.apple.com/news/?id=saqachfa>
    - Destek sayfası (2026-05-27): <https://support.apple.com/en-us/102445>
22. Tauri:
    - İmza: <https://v2.tauri.app/distribute/sign/windows/>,
      <https://v2.tauri.app/distribute/sign/macos/>,
      <https://v2.tauri.app/distribute/sign/linux/>
    - Windows yükleyicisi: <https://v2.tauri.app/distribute/windows-installer/>
    - Ayar referansı: <https://v2.tauri.app/reference/config/>, ayrıca
      `@tauri-apps/cli` 2.11.4 içindeki `config.schema.json`
    - Updater: <https://v2.tauri.app/plugin/updater/>
    - Linux paketleri: <https://v2.tauri.app/distribute/flatpak/>,
      <https://v2.tauri.app/distribute/snapcraft/>
    - NSIS şablonu:
      <https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi>
    - NSIS dilleri:
      <https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-bundler/src/bundle/windows/nsis/languages>
    - WiX şablonu:
      <https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/msi/main.wxs>
      ve `msi/mod.rs`
    - tauri-action: <https://github.com/tauri-apps/tauri-action>
23. Linux:
    - <https://docs.flathub.org/docs/for-app-authors/requirements>
    - <https://wiki.debian.org/DebianRepository/Format>
24. Velopack:
    - <https://docs.velopack.io/packaging/installer>
    - <https://docs.velopack.io/packaging/signing>
    - <https://docs.velopack.io/packaging/bootstrapping>
25. Homebrew 5.0.0 duyurusu: <https://brew.sh/2025/11/12/homebrew-5.0.0/>

**Doğrulanamayanlar:**
- SignPath Foundation'ın onay süresi. Resmî bir rakam yok.
- LobbyForge'un şu anki büyüklüğüyle SignPath'e kabul edilip edilmeyeceği.
  Elimizde yalnızca Eylül 2026'daki ret örneği var.
- SignPath Foundation'ın ortak sertifikasının yeni projelere hazır bir
  SmartScreen itibarı getirip getirmediği.
- Certum ürününün stok durumu. Sayfada "out of stock" yazıyor, sayfanın
  yapısal verisi ise "InStock" diyor.
- Türkiye'den alımda KDV uygulanıp uygulanmayacağı. Sayfa net ve brüt fiyatı
  aynı gösteriyor.
- Certum'un TOTP sırrıyla otomatik girişe kurallarında izin verip vermediği.
- Artifact Signing Premium katmanının fiyatı. Resmî sayfa tutar göstermiyor.
- winget ile kurulan imzasız bir yükleyicinin SmartScreen'e hiç takılmadığı.
  Bu yalnızca kaynak koddan çıkarıldı; 2023'te aksine bir bildirim var.
- Tauri 2 MSIX paketinde derin bağlantı, global kısayol, sistem tepsisi ve
  WebView2'nin nasıl davrandığı.
- Bireysel Store hesabında yayıncı adının serbestçe seçilip seçilemediği.
- macOS Tahoe'da Sequoia'dan sonra Gatekeeper'da ek bir değişiklik olup
  olmadığı; Apple ücretinin Türk lirası karşılığı.
- Snap'te mikrofon izninin (plug) otomatik bağlanıp bağlanmadığı.
- Velopack ile Tauri'nin birlikte kullanımı. Tauri için resmî bir rehber yok.
- Sertifika yenilendiğinde SmartScreen itibarının ne kadarının korunduğu.
