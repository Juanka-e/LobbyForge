# Eklenti kilidini açma planı: aşama 1–3 — 2026-10-12

Sahibin soruları (2026-10-10): "Eklentilerle en fazla ne yapılabilir? Bambaşka
bir uygulama yapıp içine entegre edilebilir mi? Sınırlarımız ne? Discord ile
farkımız ne?" Önerilen sıra 1 → 2 → 3 → 4 → (5 + 6) → 7 idi. Sahip
2026-10-12'de "önerdiğin sırada devam edelim" dedi. Bu belge ilk üç aşamanın
tasarımıdır.

## Karar / Öneri

- **Aşama 1 (yapıldı, PR #100):** Pazar yeri eklentisinin korumalı çerçevesi
  ses ve video çalabiliyor, WebAssembly derleyebiliyor ve **yalnızca kendi
  dosyalarını** okuyabiliyor. Uygulamaya, API'ye, başka eklentiye ve dışarıya
  hâlâ erişemiyor.
- **Aşama 2 (yapıldı, `feat/plugin-phase2`):** Eklenti dış adresler
  isteyebilir, ya da arayüzü tamamen kendi sitesinde olabilir (Discord
  Activities gibi). Bunun için **kurulumda sahibin açık onayı** şart.
  Onaylanan adresler o sürümün güvenlik politikasına yazılır. Plandan
  ayrılan noktalar aşağıda, "Aşama 2 — uygulamada" başlığında.
- **Aşama 3:** Eklenti sunucuda **etkiler** üretebilir:
  - zamanlayıcı ("30 sn sonra fazı bitir");
  - topluluk başına kalıcı küçük depo (lider tablosu);
  - sohbete uygulama mesajı;
  - (3b) ses odasında oyuncuyu susturma, örneğin VV'de ölüler.

  Her biri manifestte izin olarak istenir ve kurulumda onaylanır.
  **3a (zamanlayıcı, depo, sohbet) yapıldı (`feat/plugin-phase3`)**;
  plandan ayrılan noktalar "Aşama 3 — uygulamada" başlığında. 3b
  (`voice.mute`) sonra.
- **Ortak temel:** Aşama 2 ve 3 aynı onay akışını kullanır. Önce temeli kurmak,
  sonra iki aşamayı paralel yürütmek en hızlısı.

## Aşama 1 — çerçevede medya, WebAssembly ve kendi dosyaları

- **CSP:**
  - `script-src 'self' 'wasm-unsafe-eval'`;
  - `media-src <kendi> data: blob:`;
  - `connect-src <kendi>`.

  `<kendi>` = `https://<kurulum>/api/plugin-ui/<id>/<sürüm>/`.
- **Adres yapılandırmadan gelir, istekten değil.** Kaynak
  `LOBBYFORGE_APP_ORIGIN`, yoksa `NEXT_PUBLIC_BASE_URL`. Dosyalar herkese açık
  önbelleklenir; Host başlığının politikaya yazılması önbellek zehirlemesine
  yol açardı.
- **Dosya türleri:**
  - ses ve video: `mp3 ogg oga opus wav m4a flac webm mp4`;
  - veri: `wasm bin data pck`.
- **Range isteklerine 206.** Safari aksi halde medya çalmıyor.
- **Hâlâ yok:** worker, `eval`, SharedArrayBuffer. Çok iş parçacıklı Unity ve
  Godot derlemeleri çalışmaz; tek iş parçacıklı Godot web dışa aktarımı ve
  Emscripten derlemeleri çalışır.

## Ortak temel — manifestte istek, kurulumda onay

**Manifest (sandbox-v1), yeni ve isteğe bağlı alanlar:**

```json
{
  "network": {
    "connect": ["https://api.example.com"],
    "img": ["https://cdn.example.com"],
    "media": ["https://cdn.example.com"],
    "frame": ["https://embed.example.com"]
  },
  "ui": { "url": "https://game.example.com/play" },
  "permissions": ["timers", "storage", "chat"]
}
```

**Doğrulama:** Her iki ikiz doğrulayıcı (`apps/web/lib/sandbox-manifest.ts`,
`apps/plugin-worker/src/manifest.ts`) ortak vaka tablosuyla doğrular.

- **Adres listeleri:**
  - Yalnız `https:`.
  - Yalnız köken (origin): yol, sorgu, parça, joker ve kullanıcı bilgisi yok.
  - IP adresi, `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa` yok.
    Aksi halde izleyicilerin tarayıcısı yerel ağı taramak için kullanılabilir.
  - Liste başına en çok 8 adres.
- **`ui.url`:**
  - `https:` olmalı;
  - kökeni kurulumun kendi kökeni olamaz (çerçeve kendi sandbox'ını
    kaldırabilirdi);
  - aynı kurallardan geçer.
- **`permissions`:** Bilinen adlar `timers`, `storage`, `chat`, `voice.mute`.
  Bilinmeyen ad paketi reddettirir.

**Onay:**

- Kurulum API'si paketi indirip doğruladıktan sonra paket `network`, `ui.url`
  ya da `permissions` istiyorsa ve istekte birebir eşleşen bir `approve`
  yoksa kurmaz. `409 approval_required` ile istenenleri döner.
- Pazar yeri ekranı onay penceresini gösterir:
  - Bu eklenti şu adreslere bağlanabilir: …
  - Arayüzü şu sitede çalışır: game.example.com. O site her izleyicinin
    oyunda gördüğünü ve görünen adını görür.
  - İzinler: zamanlayıcı, kalıcı depo, sohbete mesaj.
- Sahip onaylayınca istek `approve` ile yinelenir.
- Programla yapılan bir kurulum hiçbir şeyi sessizce onaylayamaz.
- **Sürüm yükseltme:** Yeni sürüm yeni bir şey istiyorsa onay yeniden sorulur.
  Pencere farkı gösterir.
- **Kayıt:**
  - Onay `active.json`'a `approved: { network, ui, permissions, at }` olarak
    yazılır.
  - Denetim kaydına `plugin.install` satırı düşer.
- **Kaynak:** Politika etkin sürümün manifestinden üretilir. Sürüm
  değişmezdir; kurulum onaydır.
- **Kaldırma:** Kaldırmak ya da devre dışı bırakmak her şeyi geri alır.

## Aşama 2 — dış adresler ve dış arayüz

**Dosya modu (`ui: true`):** Onaylı adresler çerçevenin CSP'sine eklenir:
`connect-src`, `img-src`, `media-src` ve `frame-src`.

- Çerçevenin içindeki iframe, sandbox bayraklarını miras alır; opak köken
  kalır.
- Çerez ve depolama isteyen dış siteler bu modda çalışmaz.

**Dış arayüz modu (`ui: { url }`):** Lobi, eklentinin sitesini doğrudan
çerçeveler. Discord Activities modeline denk gelir.

- **Çerçeve:**
  `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock">`.
- **Güvenlik:**
  - `allow-same-origin` burada güvenli, çünkü site kökeni uygulamanınkinden
    farklı; site uygulamaya dokunamaz.
  - Bu yüzden kökenin farklı olması hem kurulumda hem çizimde denetlenir.
  - `allow-top-navigation`, `allow-popups` ve `allow-modals` yok.
- **Lobinin CSP'si:** `frame-src` onaylı dış arayüz kökenlerini içerir.
  - Middleware etkin eklentilerin listesini önbellekten okur (30 sn).
  - Kurulum ve kaldırmada önbellek sıfırlanır.
- **Protokol v1 aynı.** Ek kurallar:
  - Lobi mesajı yalnız `event.source === iframe.contentWindow` **ve**
    `event.origin === bildirilen köken` olunca kabul eder.
  - Lobi mesajları `targetOrigin` = bildirilen köken ile gönderir, `'*'` ile
    değil.
- **Sitenin aldığı:** Dosya modundakiyle aynı: izleyici kimliği ve adı,
  oyuncular, dil, tema, projekte edilmiş durum. Fark, bunların yazarın
  sunucusuna gidebilmesi. Onay penceresi bunu açıkça söyler.
- **Oltalama:** Etkinlik başlığında sitenin adresi rozet olarak görünür.
  Böylece içerideki "giriş yap" kutusunun LobbyForge olmadığı belli olur.
- **Eylemler:** Değişmez. Site, izleyicinin gönderebileceğinden fazlasını
  yapamaz. Eylemler lobiden, izleyicinin oturumuyla, `actionPolicies` altında
  gider.

### Aşama 2 — uygulamada (2026-10-13)

Tasarım yukarıdaki gibi uygulandı. Farklı ya da netleşen noktalar:

- **Köken denetimi daha sıkı.** Yalnız aynı köken değil, kurulumun **host'u
  (her port ve şema)** ve **alt alan adları (iki yönde)** de reddedilir.
  - Çerezler port'a değil host'a bağlıdır; aynı host'taki başka bir port
    uygulamanın çerezlerini okuyup yazabilir.
  - Alt alan adı, üst alan adı için çerez yazabilir.
  - Denetim üç yerde: kurulumda (`activateStagedBundle`), çerçeve bilgisi
    rotasında ve `PluginFrame`'de (`lib/plugin-frame-target.ts`).
  - Kardeş alt alan adları (`game.example.com` ile `chat.example.com`)
    Public Suffix List olmadan ayırt edilemez. Onay penceresi siteyi adıyla
    gösterir; sahip kendi alan adındaki bir siteyi onaylamamalı.
- **Çerçeve istemcisi ebeveyn kökenini öğrenir.** Dış sitenin kendi kökeni
  vardır ve eklentiyi kuran her kurulum onu çerçeveleyebilir.
  - İstemci ilk `init`e kadar yalnız `ready` gönderir (`'*'` ile; içi boş).
  - İlk `init`i gönderen ebeveyn penceresinin kökenini kaydeder, sonra
    yalnız o kökenle konuşur (`lf.parentOrigin`).
  - Protokol v1 aynı. Dosya modunda davranış değişmedi.
- **Dış sitede sayfa değişimi.** Dosya modunda ikinci yükleme hâlâ hata
  sayılır. Dış sitede ise sitenin kendi sayfaları arasında gezinmesi
  serbest: yeni belge `ready` der ve yeni bir `init` alır. Başka bir siteye
  giden çerçeve zaten duyulmaz ve hiçbir şey almaz (köken denetimi ve
  `targetOrigin`).
- **Rozet çerçevenin üst kenarında.** Adres çubuğu gibi: "Runs on
  game.example.com" ve "Bu ekran uygulamanın kendi web sitesi, LobbyForge
  değil" uyarısı. Çerçevenin erişilebilir başlığı da host'u söyler.
- **Önbellek.** HTML `no-cache`, çünkü politikası onaya bağlı ve aynı sürüm
  için değişebilir. Diğer dosyalar temel politikayla `immutable` kalır:
  çerçeveyi yalnız belgenin politikası yönetir.
- **Lobinin `frame-src`'si.** Onaylı siteler yalnız sayfalara eklenir; API
  rotaları ve statik dosyalar eklenmez. Önbellek 30 sn, kurulumda sıfırlanır,
  hata olursa hiçbir şey eklenmez.
- **Tarayıcı testi.** `apps/web/e2e-sandbox/external-ui.spec.ts`, ikinci bir
  yerel süreçteki (`127.0.0.1:19599–19601`) sahte siteleri kullanır.
  Chrome'un Local Network Access denetimi, Playwright'ın doldurduğu sayfayı
  "genel" sayar. Bu yüzden testte `local-network-access` izni verilir;
  üretimde iki taraf da geneldir.

## Aşama 3 — sunucu etkileri

**Etki modeli:**

- Reducer saf ve senkron kalır.
- Etki üretmek isteyen eklenti `handleAction` (ya da `createInitialState`)
  içinden SDK yardımcısıyla döner: `withEffects(nextState, [...])`. Dönen
  değer `{ __lf: 1, state, effects }`.
- Host sarmalayıcıyı tanır, etkileri doğrular ve uygular.
- Sandbox'ta da aynı JSON döner.
- **Hata:** Geçersiz ya da izinsiz bir etki eylemin tamamını reddettirir
  (`effect_refused`). Yarım uygulama olmaz.

**Etkiler:**

- **`timer.set { id, afterMs | at, action }` ve `timer.clear { id }`** (izin:
  `timers`)
  - Vadesi gelince host `action`'ı **sistem** adına reducer'a verir.
  - Eylem türü `actionPolicies`'te `"role": "system"` ile bildirilmiş olmalı.
    İstemci bu türü hiçbir zaman gönderemez; host reddeder.
  - **Sınırlar:** Oturum başına en çok 8 zamanlayıcı, süre 1 sn ile 24 sa
    arası. Aynı `id` öncekinin yerini alır.
  - **Saklama:** Zamanlayıcılar `game_sessions.timers jsonb` sütununda,
    durumla aynı CAS güncellemesinde.
  - **Çalışma tembel**, host devriyle aynı tasarım:
    - GET, eylem ya da bitirme anında vadesi gelenler kilit altında sırayla
      ve vade zamanıyla uygulanır.
    - Panel en yakın vadede bir kez yeniden okur (`nextActivityCheck`). GET
      yalnız vadeleri döner, eylemleri dönmez.
  - Resmî oyunlar da ileride kullanabilir: VV'nin istemci dürtmesi, Hushle tur
    saati, Quiz'de otomatik ilerleme.
- **`storage.set { key, value }` ve `storage.delete { key }`** (izin:
  `storage`)
  - Topluluk ve eklenti başına kalıcı depo. Var olan `plugin_data` tablosunu
    kullanır.
  - **Sınırlar:** Toplam 64 KiB, anahtar `[a-zA-Z0-9._:-]{1,128}`.
  - **Okuma:** Depo `ctx.storage` olarak senkron bir anlık görüntü halinde
    verilir (`get`, `keys`). Sandbox'a JSON olarak gider.
  - **Örnek:** lider tablosu, en iyi skor, son ayarlar.
- **`chat.post { text }`** (izin: `chat`)
  - Etkinliğin kanalının sohbetine bir **uygulama mesajı** yazar: yazar
    eklenti, "Uygulama" rozeti, `metadata.app = { pluginId }`.
  - **Metin:** En çok 500 karakter; bahsetmeler etkisiz (`@everyone` yok).
  - **Hız:** Oturum başına 5 sn'de 1, saatte 30.
  - **Örnek:** "Ayşe takımı 12–9 kazandı."
- **`voice.mute { userId, muted }`** (izin: `voice.mute`; aşama 3b)
  - Yalnız oturumun oyuncu listesinde **ve** o ses odasında olan birini
    susturur.
  - Oturum bitince ya da oyuncu listeden çıkınca susturma kalkar.
  - Bir moderatörün koyduğu susturmayı hiçbir zaman kaldırmaz; ayrı bayrak
    tutulur.
  - Denetim kaydına yazılır.

**Resmî eklentiler:** Aynı izin listesini manifestlerinde bildirir. Kod derli
olduğu için onay penceresi çıkmaz, ama aynı denetim yolu kullanılır.
`ctx.timer`, `ctx.messages` ve `ctx.storage` saplamaları (stub) etki modeline
taşınır.

## Aşama 3 — uygulamada

3a böyle yapıldı. Ayrıntılar `docs/PLUGIN_SDK.md` "Effects" bölümünde.

- **Sohbet mesajı etkinliğin kanalına gitmiyor.** Etkinlik sesli ya da
  sahne kanalında açılır ve bu kanalların lobide sohbeti yok. Oraya yazılan
  mesaj saklanır ama hiçbir yerde görünmezdi.
  - Mesaj, topluluğun uygulama için seçtiği metin ya da duyuru kanalına
    gider: Sunucu ayarları → Uygulamalar → "Uygulama mesajlarının gideceği
    kanal" (`settings.chatChannelId`). Seçim yalnız `chat` izni olan
    uygulamalarda görünür; uygulamalar rotası başka kanalı reddeder.
  - Varsayılan "hiçbir yere": mesaj düşer. Böylece kimsenin seçmediği bir
    kanala yazılmaz; özel bir ses odasının oyunu herkese açık kanala da
    taşınmaz. Kanal her mesajda yeniden denetlenir.
  - Mesajın yazarı yok (ne kullanıcı ne bot). `metadata.app = { pluginId,
    name }`; lobi eklentinin adını, uygulama simgesini ve "APP" / "UYGULAMA"
    rozetini gösterir. Masaüstü bildirimi "(UYGULAMA)" der.
  - Bahsetmeler: `@` ile başlayabilecek her yerin ardına sıfır genişlikte
    boşluk eklenir. `@everyone`, `@here` ve `@isim` kimseyi çağırmaz.
  - Hız sınırı aşılırsa mesaj **düşer** (günlüğe yazılır), eylem yine
    uygulanır. Sohbet yan kanal; oyunu durdurmamalı. Oturum başına 5 sn'de
    bir ve saatte 30'un yanında (topluluk, eklenti) başına saatte 60 sınırı
    var: etkinliği yeniden başlatmak sınırı sıfırlamaz.
  - Mesaj, topluluğun Moderasyon Botu'nun yasaklı kelime ve bağlantı
    kurallarından geçer. Engellenen mesaj düşer, `bot.moderation.block`
    olarak denetim kaydına yazılır (rol kısıtlı kanalda metin olmadan),
    eylem yine uygulanır.
  - Rol kısıtlı (özel) bir kanalı seçmek, bir bota o kanalı vermek gibi
    Kanalları Yönet yetkisi ve kanalı görebilmeyi ister.
- **Kod ve durum.** Geçersiz ya da izinsiz etki: `422 effect_refused`.
  İstemciden sistem eylemi: `403 system_action`. Sebep yalnız sunucu
  günlüğüne yazılır, istemciye gitmez.
- **Zamanlayıcı:**
  - Bir dokunuşta en çok 8 zamanlayıcı ateşlenir ve 500 ms'den sonra yenisine
    başlanmaz (önceden 32'ydi). Kendini aynı kimlikle yeniden kuran bir
    zamanlayıcı birikmişse kaçırdığı vadeler tek tek çalışmaz: geçmiş en son
    vadeye taşınır, bir kez ateşlenir. Hâlâ vadesi gelmiş olan sonraki
    dokunuşta devam eder; arada gelen eylem yeniden denenebilir 409
    (`timers_pending`) alır (güvenlik incelemesi, 2026-10-13).
  - Uygulama topluluktan kaldırılır ya da kapatılırsa açık oturumları biter
    (`activity.end`, sebep `app_uninstalled` / `app_disabled`). Yarışta açık
    kalan oturum eylem almaz (`app_not_installed`), vadesi gelen
    zamanlayıcısı çalışmadan düşer, depo yazımı ve sohbet mesajı düşer.
  - Eylemden önce, o ana kadar vadesi gelenler ateşlenir; eylem onların
    bıraktığı durumda çalışır ve hepsi tek yazımdır. Eylem reddedilirse
    zamanlayıcılar yine yazılır.
  - Hata atan, etkisi reddedilen ya da artık sistem eylemi olmayan (yeni
    sürüm değiştirdi) zamanlayıcı düşer.
  - Sistem eyleminde `ctx.actorUserId === ''` (sandbox'ta `actorId: null`),
    `ctx.now` vade zamanı. Faz tablosu ve `restartActions` istemciler için;
    sistem eylemi her zaman reducer'a gider. Örnek buzzer tur numarasını
    taşır.
  - GET, vadelerin yanında sunucunun saatini de döner (`now`). Panel cihaz
    saatine değil sunucu saatine göre sayar; ileri giden bir cihaz saati
    erken okuyup zamanlayıcıyı kaçırmaz. Kurulan ya da ateşlenen
    zamanlayıcı bus'ta `timersChanged` olarak duyurulur.
  - Bitirmede vadesi gelmiş olanlar önce ateşlenir, gerisi düşer.
  - `createInitialState` de etki döndürebilir: ilk zamanlayıcı satırla
    birlikte yazılır.
- **Depo:**
  - Anlık görüntü yalnız `storage` izniyle, oturum kilidi altında okunur.
  - 64 KiB sınırı commit'ten **önce** denetlenir (aşarsa çağrı reddedilir).
  - Yazımlar commit'ten **sonra**, tek parti halinde gider ve (topluluk,
    eklenti) kilidi altında yeniden ölçülür. Arada başka bir oturum yazmış
    olabilir. Sığmayan ya da hata veren parti düşer ve günlüğe yazılır;
    tekrar denenmez. Durum doğruluğun kaynağıdır.
  - Aynı anahtara iki oturum aynı anda yazarsa son yazan kazanır. Örnek
    lider tablosu yazarken anlık görüntüyle birleştirir.
- **Sandbox.** Worker `{ result, effects }` ya da `{ unchanged, effects }`
  döner. `ctx.storage` yalnız `createInitialState` ve `handleAction`
  çağrılarında var, `projectState`'te yok. Worker'a giden anlık görüntü
  256 KiB ile sınırlı (yedek denetim).
- **İzinler.** Resmî eklenti `manifest.permissions`'a `timers`, `storage`,
  `chat` yazar; eski adlar (`manage_timer` vb.) bir şey vermez. Pazar yeri
  eklentisinin etkin izinleri `describeWorkerPlugin`'de hesaplanır:
  istenen **ve** onaylanan. Kurulum `describe`'a onayı geçirir.
- **SDK.** `GamePlugin`'e dördüncü bir tür parametresi eklendi: etki
  döndüren eklenti `GamePlugin<S, A, P, ReducerResult<S>>` yazar; mevcut
  oyunlar değişmedi. `ctx.storage` artık eşzamanlı anlık görüntü (eski
  async API'yi hiçbir eklenti kullanmıyordu). `ctx.timer` ve `ctx.messages`
  kullanımdan kalktı, no-op. Test aracı etkileri uygular ve zamanı ilerletir
  (`advanceTime`).
- **Örnek.** `sandbox-buzzer` 0.2.0: tur 30 sn sonra kendiliğinden açıklanır
  (15 sn uçtan uca testte kısa kalırdı) ve depoda topluluğun en hızlı beş
  tepkisi tutulur.
- **`voice.mute`.** Manifestte istenebilir ve onaylanabilir; etki türü henüz
  yok, reddedilir.
- **Resmî oyunlar** zamanlayıcıya geçmedi (ayrı iş): VV dürtmesi, Hushle tur
  saati, Quiz otomatik ilerleme.
- **Açık:** Uygulama mesajları moderasyon botunun kelime kurallarından
  geçmiyor. Oyuncunun yazdığı bir takım adı sohbete taşınabilir.

## Kötüye kullanım açısı

| Niyet | Sonuç |
|---|---|
| Gizli bilgiyi dışarı yollamak (aşama 2) | Yalnız onaylı adreslere. Onay penceresi bunu söyler; varsayılan hâlâ "ağ yok" |
| İzleyicinin tarayıcısıyla yerel ağı taramak | IP, `localhost` ve yerel alan adları reddedilir; yalnız `https:` |
| Dış arayüzün uygulamayı ele geçirmesi | Köken farklı olmak zorunda. Popup, üst gezinme ve modal yok. Lobi mesajları köken ve kaynakla doğrular |
| Oltalama | Başlıkta sitenin adresi görünür. Çerez ve depolama sitenin kendi kökeninde, uygulamanınkine erişemez |
| Zamanlayıcıyla yük bindirmek | En çok 8 zamanlayıcı, en az 1 sn. Tembel çalışma: kimse bakmıyorsa hiçbir şey çalışmaz |
| Sohbeti doldurmak | 5 sn'de 1, saatte 30, 500 karakter, bahsetme yok |
| Depoyu şişirmek | 64 KiB toplam |
| Susturmayı kötüye kullanmak | Yalnız oyuncu ve aynı oda. Oturum bitince kalkar, moderatör susturmasına dokunmaz, denetim kaydına yazılır |
| Onayı atlamak | `approve` istenenle birebir eşleşmeli. Yeni sürüm yeni bir şey isterse yeniden sorulur |

## Plan

| # | İş | Kim | Test |
|---|---|---|---|
| 1 | Aşama 1 | yapıldı (PR #100) | rota testleri, tarayıcı (`e2e-sandbox`) |
| 2 | Ortak temel: manifest alanları (ikiz doğrulayıcılar), `approval_required` ve `approve`, onay penceresi (en, tr), `active.json` kaydı, denetim kaydı, yükseltmede fark | ben | doğrulayıcı vaka tablosu, kurulum rotası, pencere bileşeni |
| 3 | Aşama 2: eklenti başına CSP, middleware `frame-src` önbelleği, `PluginFrame` dış arayüz modu, köken rozeti | yapıldı (`feat/plugin-phase2`) | rota ve middleware testleri; tarayıcı: dış kökenli sahte site protokolü konuşur, kökeni yanlış mesaj reddedilir |
| 4 | Aşama 3: `withEffects`, `role: system`, zamanlayıcılar (göç + tembel çalışma), depo, sohbet mesajı; SDK test aracı; sandbox eşlemesi | yapıldı (`feat/plugin-phase3`) | reducer, rota ve worker testleri; örnek buzzer'a zamanlayıcı ve lider tablosu |
| 5 | Aşama 3b: `voice.mute` | sonra | ayrı tasarım incelemesi |

## Doğrulanamayanlar

- Dış arayüz modunda Safari'nin üçüncü taraf çerez ve depolama kısıtları
  (ITP). Site kendi kökeninde olsa da çerçeve içinde depolama bölümlenir. Yazar
  depolamaya güvenmemeli. Ayrıca durumu lobiden alır.
- Masaüstünde (Tauri) dış kökenli iframe'in WebView2 ve WKWebView'da aynı
  davrandığı.
- Chrome'un Local Network Access denetimi: genel adresteki bir kurulum,
  yerel ağdaki (ör. geliştiricinin `localhost`'undaki) bir dış arayüzü
  çerçevelerken izin ister ya da engeller. Üretimde iki taraf da genel
  olduğu için etkilemez; yerel geliştirmede kurulum da yerel olmalı.
