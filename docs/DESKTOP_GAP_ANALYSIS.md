# LobbyForge Desktop (Tauri 2) — Eksik Analizi

Tarih: 2026-08-31 · İncelenen: `apps/desktop/` @ commit `b00f452` + CI run `33386813563`
Yöntem: Kaynak okuma (Rust kabuğu, TS sözleşmeleri, tauri.conf.json, capabilities, dist-shell) + CI derleme günlükleri. Tahmin yok; her bulgu kanıtla.

---

## 0. Özet karar

**Mimari doğru ve sağlam**: connect-to-server modeli (tek installer → kullanıcı instance URL'si girer), üst-düzey webview navigasyonu (iframe/CSP çakışması bilinçli olarak tasarım kararıyla aşılmış), URL doğrulama Rust+TS iki tarafta da aynen uygulanmış, yetenekler (capabilities) dar kapsamlı. CI 3 platformda installer üretiyor (Windows MSI+NSIS, macOS DMG+.app, Linux AppImage+deb) — son koşumda hepsi yeşil.

**Ama dağıtıma hazır değil.** Bir P0 (PTT zinciri connected durumda kopuyor), bir P0-dağıtım engeli (macOS mikrofon izni yok → ses çalışmaz) ve otomatik güncelleme hiç yok. Aşağıda 17 bulgu, önem sırasıyla.

| Sınıf | Adet |
|---|---|
| P0 — çekirdek işlev kırık / dağıtım engeli | 3 |
| P1 — vaadedilmiş ama çalışmayan özellikler | 5 |
| P2 — dağıtım kalitesi / UX | 6 |
| P3 — teknik borç | 3 |

---

## 1. P0 — Ses (ürünün kimliği) macOS'ta çalışmaz

**Bulgu DP-01 · macOS mikrofon izni tanımlı değil.**
`src-tauri/` altında özel `Info.plist` yok; `tauri.conf.json`'da `bundle.macOS.entitlements`/`info plist` bölümü yok. Tauri 2'de WebView2/WebKit'in `getUserMedia` çağrısı, macOS'ta `NSMicrophoneUsageDescription` olmadan **çöker veya sessizce reddedilir**. Ses-önce-coming bir istemcide bu, Mac installer'ın fiilen kullanılamaz olması demektir.
**Düzeltme:** `bundle > macOS > infoPlist` altına `NSMicrophoneUsageDescription` (ve kamera için `NSCameraUsageDescription`) ekle; `entitlements` dosyasında `com.apple.security.device.audio-input` beyan et. Windows tarafı WebView2 izinlerini otomatik yönetir — ek işlem gerekmez, ancak canary testi şart (DP-17).

## 2. P0 — PTT zinciri instance'a bağlandıktan sonra kopuyor

**Bulgu DP-02 · `lib.rs` PTT'yi `window.emit` ile yolluyor; hedef dinleyici bağlı sayfada yok.**
Zincir tasarımı: global kısayol (Rust) → Tauri event `lobbyforge://ptt` → `dist-shell/shell.js` bunu `postMessage`'e çeviriyor → `LobbyVoiceProvider.tsx:924` `postMessage` dinliyor.
Sorun: `connect_instance` webview'i `window.location.href = https://instance/` ile **uzak sayfaya** götürüyor → `shell.js` bellekten boşaltılıyor. Dönüştürücü (Tauri event → postMessage) artık yok. Üstelik uzak origin'de `__TAURI__` globali enjekte edilmiyor (`withGlobalTauri` kapalı; `dangerousRemoteDomainIpcAccess` de yok — ve olmamalı) → uzak sayfa Tauri event'lerini **dinleyemez**.
Sonuç: connect ekranındayken PTT çalışır (kimsenin işine yaramaz), gerçek instance sayfasındayken **ölü**. Bu, denetim raporlarındaki LF-011 bulgusunun ta kendisi — kod incelemesiyle doğrulandı.
**Düzeltme (IPC açmadan):** `emit_ptt` içinde `window.emit(...)` yerine `window.eval("window.postMessage({type:'lobbyforge:ptt',pressed:...},'*')")` kullan — `eval` uzak sayfada da çalışır, IPC yüzeyi açılmaz. (~5 satır.)

## 3. P0-dağıtım — İmzasız installer'lar

**Bulgu DP-03 · Hiçbir platformda kod imzalama/notarizasyon yok.**
Workflow'da `signingIdentity`/sertifika secret'ı yok; macOS build `.sig` üretiyor ama kimlik yok, Windows APPX/SmartScreen imzası yok.
- **macOS**: Gatekeeper "tanınmayan geliştirici" der ve DMG karantinaya düşer (`xattr -c` ile aşılabiliyor ama kullanıcı bunu bilmemeli). Notarizasyon olmadan ilk açılışta korkutucu uyarı.
- **Windows**: SmartScreen "Bilinmeyen yayıncı" mavi ekranı → dönüş oranını öldürür.
**Düzeltme:** Apple Developer ID + `APPLE_CERTIFICATE` secret'ları + `tauri-action`'ın notarizasyon adımı; Windows için en azından self-signed/bağımsız imza, ideali OV sertifikası. **Sertifika alınana kadar:** README'ye dürüst "imzasız alpha — SmartScreen: More info → Run anyway / macOS: xattr" talimatı.

---

## 4. P1 — Var ama çalışmayan özellikler (config yalanları)

**DP-04 · Otomatik güncelleme hiç yok.** `DesktopConfig.autoUpdate: true` varsayılan; ama `Cargo.toml`'da `tauri-plugin-updater` **yok**, konfigürasyonda updater endpoint'i yok, imza anahtarı yok. Kullanıcı ayarında "otomatik güncelle" diye dokunulabilir bir yalan var.
**Düzeltme:** updater plugin + minimum imzalı `latest.json` (GitHub Releases) + `createUpdaterArtifacts: true`. Ya da kısa vadede config'den `autoUpdate`'i kaldır (görünür no-op = audit'in eleştirdiği desen).

**DP-05 · `DesktopConfig` bayrakları Rust tarafından hiç okunmuyor.** `enableTray`, `startMinimized`, `globalPushToTalk` — hiçbiri `lib.rs`'te yok. Tray koşulsuz kurulur, PTT koşulsuz kaydedilir, minimize başlatma diye bir şey yok.

**DP-06 · 4 kısayoldan 3'ü kayıtlı değil.** `DEFAULT_SHORTCUTS` sözleşmede `toggleMute` (Ctrl+Shift+M), `toggleDeafen` (Ctrl+Shift+D), `openSettings` (Ctrl+,) tanımlı; `lib.rs` yalnızca `Control+Space` kaydediyor. Diğerleri ölü sayaç. (İşlevsel olmaları için web tarafına kısayol→aksiyon event köprüsü de gerekir — DP-02'nin düzeltmesiyle aynı mekanizma.)

**DP-07 · Oturum devri (handoff) üreticisi yok.** `parseDesktopSessionHandoff` (TS) `lobbyforge://session/complete?code&state&instance` formatını **doğrulamakta ve test edilmekte**; `deep_link` plugin'i `Builder`'a eklenmiş. Ama: (a) web API'de bu tek-kullanımlık kodu **üreten** uç yok, (b) `lib.rs`'te deep-link **olay dinleyicisi** kayıtlı değil (plugin init ≠ handler), (c) `lobbyforge://` şeması `tauri.conf.json > plugins > deep-link > desktop > schemes`'de beyan edilmemiş → işletim sistemi kaydı olmayabilir. Sonuç: "desktop'ta instance hesabınla giriş" akışının yarısı — ayrıştırıcı var, akış yok. (Audit'in "state-bound handoff parser" bulgusu yalnızca parser'ı övmüştü; akışın bütünü hâlâ yok.)

**DP-08 · `bundle.targets` yalnızca `["msi","nsis"]`.** macOS/Linux paketleri config'te yok; CI'da `tauri-action` bunları üretiyor (günlükte DMG/AppImage/deb var — doğrulandı) ama **yerelde** `pnpm tauri build` (mac/linux) hiçbir şey üretmez. Platform matrisi ile config tutarsız: `targets: "all"` veya platform-başlı profil olmalı.

---

## 5. P2 — Dağıtım kalitesi / UX eksikleri

**DP-09 · İkonlar Tauri varsayılanları.** `icons/` seti şablonun getiridği jenerik Tauri ikonu (512×512 PNG doğrulandı). Ürün logosu/brendi yok — install ekranından görev çubuğuna kadar "template uygulama" görünüyor. (Web tarafındaki instance-logo işinden bağımsız olarak app'in kendi kimliği.)

**DP-10 · Bildirim eklentisi takılı, hiç kullanılmıyor.** `tauri-plugin-notification` init var; gönderen yok. Bahsedilmemiş mesaj, sesli oda daveti, arkadaş isteği — desktop'un asıl avantajı olacak özellikler boş. (Web'de `Notification` API webview'de çalışmayabilir/güvenilmez olabilir; plugin doğru seçim, kullanılmıyor.)

**DP-11 · Pencere durumu hatırlanmıyor.** `tauri-plugin-window-state` yok → boyut/konum her açılışta sıfırlanır. Kullanıcının en çok farkettiği küçük sinir bozucu.

**DP-12 · Bağlan ekranı erişilebilirlik ön-kontrolü yapmıyor.** URL formatı doğrulanıyor (iyi) ama instance'ın ayakta olup olmadığı `GET /api/health` ile yoklanmıyor; kullanıcı yanlış URL'yi ancak navigasyondan sonra boş sayfa/hata ile anlar. Ayrıca TLS hatası/çevrimdışı ayrımı gösterilmiyor.

**DP-13 · Tek instance / tek profil.** Store'da tek `instanceUrl`; birden fazla topluluk arasında geçiş = URL'yi elle yeniden yazmak. "Sunucu listesi + hızlı geçiş" (Discord'un multi-server akıl modeli) kabuğun doğal uzantısı olurdu.

**DP-14 · Otomatik başlatma / tepsi-başlat seçeneği yok.** `tauri-plugin-autostart` eklenmemiş; "bilgisayarla başlat" ayarı yok. Tray var ama ayara bağlı değil (DP-05).

---

## 6. P3 — Teknik borç

**DP-15 · Kabuk CSP'si `script-src 'unsafe-inline'` içeriyor.** `tauri.conf.json` security.csp. Yerel connect ekranı için risk düşük (statik shell.js, uzak içerik yok) ama proje standardı (web app'de nonce, unsafe-inline yok) ile tutarsız. `script-src 'self'` + inline script'in dosyaya taşınması temizler.

**DP-16 · `disconnect_instance` yarım kalıyor.** `shell.js`'te `__lobbyforgeNavigate(null)` için **boş gövde** var ("Rust side should navigate…" yorumuyla) ve Rust da geri navigasyonu yapmıyor — `webview_url` ile `tauri://localhost`/yerel index'e dönülmüyor. "Switch instance" akışı fiilen kopuk: tek yol uygulamayı yeniden başlatmak.

**DP-17 · Paketlenmiş uygulama hiç çalıştırılmadı.** CI installer'ları üretir ama **indirip kurup açan hiçbir test yok** (LF-011'in açık kalan yarısı). DP-01 ve DP-02 tam da bu sınıf testle yakalanırdı. Minimum: CI'da Windows runner'da MSI kur + aç + connect ekranı göründüğünü doğrula (UI otomasyonu ağır; process aç + health screenshot bile DP-01 sınıfı çökmeleri yakalar). macOS notarizasyon sonrası elle matris: mikrofon izni diyaloğu, PTT, ses.

---

## 7. Önerilen sıra (Release-öncesi kapı listesi)

1. **DP-02** PTT `window.eval` köprüsü — 5 satır, çekirdek işlevi geri getirir
2. **DP-01** macOS `NSMicrophoneUsageDescription` + entitlements — config maddesi, Mac'i kullanılabilir yapar
3. **DP-08** `bundle.targets` tutarlılığı — tek satır
4. **DP-04** updater **veya** `autoUpdate`'i config'den düşür — dürüstlük kapısı
5. **DP-16** disconnect navigasyonunu tamamla
6. **DP-05/06** config bayraklarını Rust'a bağla; 3 ölü kısayolu ya kaydet ya sil
7. **DP-09** gerçek LobbyForge ikon seti
8. **DP-17** kur-çalıştır smoke testi (Windows CI)
9. **DP-03** imzalama/notarizasyon — sertifika alınınca; öncesinde README'ye imzasız-alpha talimatı
10. **DP-07** handoff üreticisi (web API ucu + deep-link şema kaydı + handler) — desktop girişinin tamamı
11. DP-10/11/13/14 — UX turu; DP-15 temizlik

---

*Bu rapor kaynak kodu ve CI günlüklerine dayanır; tahminî önem dereceleri LobbyForge'un "ses-önce gelen, self-host topluluk" konumlandırmısına göre verilmiştir.*
