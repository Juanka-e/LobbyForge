# Güvenlik İncelemesi ve Ürün Kıyaslaması — 2026-10-03

> **Güncelleme (aynı gün): 17 bulgunun hepsi düzeltildi.** Ayrıntılar
> §12'de. §1–§11 incelemenin ilk hâlidir ve kayıt olarak korunuyor.

Kapsam: `main` @ `38945b6` (PR #41 dahil), kod tabanının tamamı: web
uygulaması ve 85 API rotası, ws-gateway, plugin worker sandbox'ı,
etkinlik eklentileri, botlar, registry/dizin, Tauri masaüstü, Docker /
nginx / coturn / LiveKit, `install.sh`, `lfctl` güncelleyici ve CI.

Yöntem: altı salt-okunur inceleyici alanlara bölündü (kimlik doğrulama,
yetkilendirme/IDOR, etkinlik-eklenti-bot-gateway, yükleme ve içerik
gösterimi, altyapı-CI-güncelleme, registry-dizin-masaüstü). Hepsi
`security-review` becerisinin kuralına göre çalıştı: yalnızca saldırgan
girdisi uçtan uca izlenmiş, **yüksek güvenli** bulgular raporlandı.
Raporlanan her bulgu ayrıca koda karşı tek tek doğrulandı (dosya:satır
aşağıda). Kod değişikliği yapılmadı. Rakip kıyaslaması ve özellik
önerileri ayrı bir analiz ajanının web araştırmasından geliyor (§8–§10).

## 1. Karar

**Kritik bir uygulama açığı yok; kurulumla gelen bir altyapı açığı
yüksek önemde ve hemen kapatılmalı.** Eylül incelemesindeki
düzeltmelerin (S1–S11) hiçbiri geri gelmemiş, ama üçü yan yoldan
kısmen aşılıyor (S7 → AUTH-001, S9 → INFRA-002, S11 → PLUG-001).

En önemli tek bulgu **INFRA-001**: `install.sh` ile yapılan her Linux
kurulumunda coturn kendi ayar dosyasını okuyamıyor ve **kimlik
doğrulamasız, açık bir TURN relay'i** olarak çalışıyor. Ses yine
çalıştığı ve healthcheck geçtiği için hiçbir şey bunu göstermiyor.
Herkese açık bir VPS kurulumundan önce bu kapatılmalı.

| Önem | Sayı | Bulgular |
|---|---|---|
| Kritik | 0 | — |
| Yüksek | 1 | INFRA-001 |
| Orta | 7 | AUTH-001, AUTHZ-001, AUTHZ-002, AUTHZ-003, PLUG-001, FILE-001, HUB-001 |
| Düşük | 9 | AUTH-002, AUTHZ-004, AUTHZ-005, AUTHZ-006, PLUG-002, HUB-002, HUB-003, FILE-002, INFRA-002 |

## 2. Bulgu özeti

| ID | Önem | Bulgu | Ana konum |
|---|---|---|---|
| INFRA-001 | **Yüksek** | Her `install.sh` kurulumunda coturn kimlik doğrulamasız açık relay | `install.sh:23`, `scripts/render-configs.sh:68-71`, `docker-compose.prod.yml:337` |
| AUTH-001 | Orta | Şifre değişikliğinden önce alınmış masaüstü giriş kodu sonra da oturum açıyor | `api/auth/desktop-session/complete/route.ts:74-94` |
| AUTHZ-001 | Orta | Bir kanalı tek başına kapatan rol silinince kanal herkese açılıyor | `packages/db/src/queries/roles.ts:324-333`, `channelVisibility.ts:87` |
| AUTHZ-002 | Orta | Ayrılıp geri katılmak timeout ve sunucu susturmasını sıfırlıyor; ayrılan kişi banlanamıyor | `members/[userId]/route.ts:80-95`, `lib/member-authorization.ts:123-128` |
| AUTHZ-003 | Orta | MANAGE_MESSAGES sahibi herkesin (sahibin de) mesaj **metnini** değiştirebiliyor | `messages/[messageId]/route.ts:130-138,207-209` |
| PLUG-001 | Orta | Denetim günlüğü Vampire Village rollerini ve anonim ankette kimin neye oy verdiğini sızdırıyor | `activities/[sessionId]/actions/route.ts:434-441` |
| FILE-001 | Orta | Tüm üyelerin avatar/banner data URL'leri her `/lobby` yüklemesine gömülüyor (sayfa şişirme DoS) | `memberships.ts:362-392`, `app/lobby/page.tsx:433` |
| HUB-001 | Orta | Her kurulumun dizin `instanceId`'si aynı sabit; ilk kaydeden herkes adına kapıyor (bugün başka bir hata yüzünden gizli) | `instanceSettings.ts:6,518,551`, `.well-known/lobbyforge-verification/route.ts:54` |
| AUTH-002 | Düşük | İptal edilen oturum sunucu tarafında oluşturulan sayfalarda (lobby, admin) ve tek bir API rotasında 60 dk'ya kadar çalışıyor | `app/lobby/page.tsx:605-606`, `lib/admin-auth.ts:28-40`, `api/admin/bandwidth/route.ts:27-29` |
| AUTHZ-004 | Düşük | Davet kullanımı "ilk katılımda onay" erişim politikasını uygulamıyor | `api/invites/[code]/redeem/route.ts:51`, `invites.ts:240-357` |
| AUTHZ-005 | Düşük | "Profil görünürlüğü" ayarı kaydediliyor ama hiç uygulanmıyor | `api/settings/me/route.ts:26`, `app/lobby/page.tsx:433` |
| AUTHZ-006 | Düşük | Susturulan veya timeout alan üye ekran paylaşımı sesiyle konuşabiliyor | `lib/voice-moderation.ts:49-58` |
| PLUG-002 | Düşük | Atılmış veya banlanmış host kendi etkinliğini bitirebiliyor (üyelik kontrolü yok) | `activities/[sessionId]/end/route.ts:57-84` |
| HUB-002 | Düşük | Listelenmiş dizin kaydı, yalnızca sahibin hub oturumuyla yeniden incelenmeden yeniden adlandırılabiliyor | `registryInstances.ts:176-196`, `api/directory/register/route.ts:154-203` |
| HUB-003 | Düşük | Bayatlamış (alan adı el değiştirmiş olabilecek) kayıtlar detay ve çıkış sayfasından hâlâ erişilebilir | `discover/[instanceId]/page.tsx:64`, `discover/go/page.tsx:49,127` |
| FILE-002 | Düşük | Dizin doğrulama hatası iç DNS adlarını, Docker IP'lerini ve port durumunu yansıtıyor | `api/directory/register/route.ts:76-82`, `change-domain/route.ts:145-150` |
| INFRA-002 | Düşük | Yerel derlenen imaja TURN gizli anahtarı giriyor; marketplace eklentisi okuyabilir | `.dockerignore`, `Dockerfile:6` |

## 3. Bulgular

### INFRA-001 — Her `install.sh` kurulumunda coturn açık relay (Yüksek)

- **Konum:** `install.sh:23` (`umask 077`), `scripts/render-configs.sh:68-71`
  (`sed … > "$target"`), `install.sh:393` (`mv`), `infra/docker/docker-compose.prod.yml:337`
  (`../turn/turnserver.conf:/etc/coturn/turnserver.conf:ro`), `infra/turn/cert-watcher.sh`
  (`exec turnserver -c /etc/coturn/turnserver.conf`).
- **Zincir:**
  1. Kurulum betiği `umask 077` ile çalışıyor; render edilen `turnserver.conf`
     0600 ve kurulumu yapan kullanıcıya (genelde root) ait oluyor. `mv` izinleri koruyor.
  2. Resmî coturn imajı `USER nobody:nogroup` ile çalışıyor (coturn
     `docker/coturn/debian/Dockerfile`); compose `user:` vermiyor. Linux bind
     mount'ta dosya izinleri aynen geçtiği için `nobody` dosyayı okuyamıyor.
  3. coturn ayar dosyasını bulamayınca "default and command-line settings"
     ile açılıyor. Belgesine göre hiçbir kimlik doğrulama seçeneği yoksa
     varsayılan `--no-auth`: "any user is allowed".
  4. Şablondaki her koruma düşüyor: paylaşılan gizli anahtar, tüm
     `denied-peer-ip` aralıkları, kotalar ve relay port aralığı. coturn'ün
     yerleşik varsayılanı yalnızca loopback / link-local / ULA'yı engelliyor;
     10/8, 172.16/12, 192.168/16 açık.
- **Saldırgan:** internetteki herkes, hesap gerekmez (3478 kurulumda açılıyor).
- **Etki:** operatörün IP'si üzerinden anonim proxy (kötüye kullanım şikâyetleri
  operatöre gelir). `network_mode: host` olduğu için TCP relay ile Docker
  köprü ağına (web:3000, ws-gateway, LiveKit 7880) ve sağlayıcının özel ağına
  erişim. `web:3000`'e nginx'i atlayarak `X-Forwarded-For` uydurarak giriş
  denemesi yapılabildiği için IP tabanlı hız sınırları da aşılıyor.
- **Neden fark edilmedi:** ses bu durumda da çalışıyor, healthcheck yalnızca
  3478'e TCP bağlantısı deniyor, `docs/VOICE_TURN.md` duman testi açık
  sunucuda da geçiyor. Eylül provaları Windows Docker Desktop'ta yapıldı;
  orada bind mount izinleri uygulanmadığı için dosya okunabiliyordu.
- **Düzeltme:**
  - Render'dan sonra `chown 65534:65534 infra/turn/turnserver.conf && chmod 0400`
    (ya da grup `nogroup`, 0640).
  - `cert-watcher.sh` başında `[ -r /etc/coturn/turnserver.conf ] || { echo …; exit 1; }`
    ile fail-closed başlat.
  - CI'da `umask 077` ile render edip sabitlenmiş imajı varsayılan kullanıcıyla
    başlatan ve kimliksiz bir Allocate'in **401** aldığını doğrulayan bir test.
  - Aynı değişiklikte: `nobody` Let's Encrypt özel anahtarını da okuyamıyor,
    yani duyurulan `turns:…:5349` hiç çalışmıyor. Sertifika erişimini de düzelt.
  - Ek: `no-tcp-relay`, sunucunun kendi genel IP'si ve `192.0.0.0/24`,
    `198.18.0.0/15`, `240.0.0.0/4` için `denied-peer-ip`.

### AUTH-001 — Masaüstü giriş kodu şifre değişikliğinden sağ çıkıyor (Orta)

- **Konum:** `apps/web/app/api/auth/desktop-session/route.ts:63-68` (kayıt yalnızca
  `{userId, state, used}`), `…/complete/route.ts:74-94` (yalnızca kullanıcı var mı
  ve silinmemiş mi bakılıyor), `api/auth/password/route.ts:63` (yalnızca
  `revokeOtherSessions`).
- **Saldırgan:** kurbanın şifresini bilen biri (oltalama, yeniden kullanılan şifre).
- **Saldırı:** saldırgan ~4 dakikada bir `POST /api/auth/desktop-session` ile
  yeni bir `{code,state}` alır (10/15 dk sınırının içinde). Kurban fark edip
  şifresini değiştirir; kayıtlı oturumlar iptal edilir. Saldırgan elindeki son
  kodu 5 dakika içinde `/complete`'e gönderir, **yeni ve iptal listesinde
  olmayan** bir oturum alır ve bunu `POST /api/auth/guest` ile süresiz uzatır.
- **Etki:** Eylül'deki S7 düzeltmesinin amacı ("şifre değişikliği saldırganı
  dışarı atar") bu yoldan boşa çıkıyor.
- **Düzeltme:** kodu üretirken kimlik bilgisinin parmak izini (ör.
  `passwordHash`'in hash'i ya da bir `credentialVersion`) kayda yaz, tamamlanırken
  eşleşmiyorsa 401 ver. Ayrıca kullanıcı başına açık kodları indeksle ve şifre
  rotasında sil. Test: kod al → şifre değiştir → complete 401.

### AUTHZ-001 — Rol silmek gizli kanalı herkese açıyor (Orta)

- **Konum:** `api/servers/[id]/roles/[roleId]/route.ts:313-323` → `packages/db/src/queries/roles.ts:324-333`;
  `0028_channel_role_overrides.sql:7` (`role_id … ON DELETE CASCADE`);
  `channelVisibility.ts:87` (`if (overrides.length === 0) return true;`).
- **Saldırgan:** `MANAGE_ROLES` sahibi, `MANAGE_CHANNELS` yetkisi olmayan ve
  kapı rolünün üstünde olan bir moderatör. Sahip de kazara tetikleyebilir.
- **Saldırı:** `#staff` yalnızca "Staff" rolüne açık. Moderatör `DELETE
  /roles/{staffRoleId}` gönderir; override satırları cascade ile silinir; "override
  yok = herkese açık" kuralı yüzünden kanal, misafirler dahil herkese görünür,
  geçmişi okunur, sesli odasına girilir.
- **Etki:** özel kanal içeriği tüm sunucuya sızar; kanal görünürlüğünü
  değiştirmek için gereken `MANAGE_CHANNELS` aşılmış olur.
- **Düzeltme:** `deleteRole` içinde, aynı transaction'da bu rolün **son**
  override olduğu kanalları bul; 409 ile reddet (kanalları listele) ya da
  `MANAGE_CHANNELS` iste. Route testi ekle.

### AUTHZ-002 — Ayrılıp geri katılmak timeout ve susturmayı sıfırlıyor (Orta)

- **Konum:** timeout ve sunucu susturması yalnızca üyelik satırında
  (`schema.ts:155,162`); kendi isteğiyle ayrılmak satırı siliyor
  (`members/[userId]/route.ts:80-95`, `memberships.ts:275-287`); yeniden katılma
  temiz satır yaratıyor (`invites.ts:327-334`, `app/lobby/page.tsx:630-646`);
  ban hedefin üye olmasını istiyor (`lib/member-authorization.ts:123-128`).
- **Saldırgan:** timeout ya da sunucu susturması almış herhangi bir üye
  (`CREATE_INVITE` varsayılan olarak `@everyone`'da).
- **Saldırı:** `POST /invites` (timeout kontrol edilmiyor) → `DELETE
  /members/{self}` → `POST /invites/{code}/redeem`. Açık kayıtlı kurulumda son adım
  yalnızca `/lobby`'yi açmak. Ayrıldığı sürece moderatör onu banlayamaz
  (`POST /bans` → 404 "not a member").
- **Etki:** 28 günlük timeout ya da susturma birkaç saniyede kalkıyor.
- **Düzeltme:** moderasyon durumunu üyelikten bağımsız `(serverId, userId)`
  anahtarlı bir tabloda tut (ya da `redeemInvite` ve `ensureServerMembership*`
  içinde kontrol et). Üye olmayan kullanıcıyı banlamaya izin ver; hiyerarşi
  kontrolünü yalnızca hedef hâlâ üyeyse uygula.

### AUTHZ-003 — Moderatör başkasının mesaj metnini yeniden yazabiliyor (Orta)

- **Konum:** `api/servers/[id]/channels/[channelId]/messages/[messageId]/route.ts:130-138`
  (`canMutateMessage`: yazar **ya da** `MANAGE_MESSAGES`), `:207-209` (içerik
  düzenlemesi bu kapıdan geçiyor).
- **Saldırı:** herhangi bir rütbedeki `MANAGE_MESSAGES` sahibi `PATCH
  …/messages/{sahibinMesajı} {"content":"Adminliğimi X'e veriyorum"}` → 200.
  Mesaj hâlâ asıl yazara ait görünüyor, yalnızca "düzenlendi" işareti alıyor.
  Arayüz bunu sunmuyor (`LobbyLiveRoster.tsx:485` `isOwn ?`); bu bir sunucu açığı.
- **Etki:** moderatör, kendinden üst rütbedekiler ve sahip dahil herkesin ağzına
  söz koyabilir. Gerçek düzenleyeni yalnızca denetim günlüğü gösterir.
- **Düzeltme:** içerik düzenlemesini yalnızca `isAuthor` için aç;
  `MANAGE_MESSAGES` silme ve sabitleme için kalsın. Yazar olmayana 403 testi.

### PLUG-001 — Denetim günlüğü gizli oyun bilgisini sızdırıyor (Orta)

- **Konum:** `api/servers/[id]/activities/[sessionId]/actions/route.ts:434-441` her
  aksiyon için `{actorUserId, metadata:{pluginId, actionType}}` yazıyor;
  `api/servers/[id]/audit-logs` bunu `VIEW_AUDIT_LOG` sahiplerine veriyor.
- **Saldırgan:** `VIEW_AUDIT_LOG` sahibi üye (sahip, varsayılan `@admin`; resmî hub'da
  sunucu açan herkes) — aynı zamanda oyunun oyuncusu.
- **Saldırı:**
  - **Vampire Village:** oyun sırasında günlükte `actionType:'pack-chat'` bir
    vampiri, `'night-shield'` hayatta kalanı, `'night-target'` gece rolü olan
    birini gösteriyor (köylüler gece aksiyonu göndermez). Reddedilen aksiyonlar
    da yazılıyor (log, CAS'tan sonra `stateChanged`'e bakmadan çalışıyor).
  - **Anket:** her oy bir revizyon. Paneldeki sayı değişimleri ile sırayla gelen
    `vote` satırları eşlenince oy veren → seçenek çıkıyor.
- **Etki:** `projectActivityState`'in koruduğu gizli roller ve S11 ile kapatılan
  anket anonimliği pasif olarak sızıyor. `docs/VAMPIRE_VILLAGE.md`'deki "tek yan
  kanal bus zamanlaması, kim veya ne asla" ifadesi doğru değil.
- **Düzeltme:** `member` rolündeki oyun aksiyonları için satır yazma; host ve
  moderasyon aksiyonlarını (start/end/kick/configure) tut. Ya da
  `actionPolicies`'e `audit: false` ekle. Durum değiştirmeyen aksiyonları hiç
  yazma. VV `pack-chat`/`night-*` ve Poll `vote` için "aktör+tip içeren satır yok"
  testleri.

### FILE-001 — Lobby sayfası tüm üyelerin resimlerini gömüyor (Orta)

- **Konum:** `packages/db/src/queries/memberships.ts:362-392` (`listMemberSummariesForServer`,
  LIMIT yok, `avatar_url` + `banner_url` seçiliyor) → `app/lobby/page.tsx:433` →
  istemci bileşenleri; `LobbyMembersClient.tsx:405` avatarı SSR'da `<img src="data:…">`
  olarak bir kez daha basıyor. Sınırlar: avatar ~6 MB, banner ~8 MB data URL
  (`users/me/avatar/route.ts:13`, `banner/route.ts:13`), kullanıcı başına 24 MB.
- **Saldırgan:** sunucunun herhangi bir üyesi (açık katılımda misafir dahil).
- **Saldırı:** her saldırgan hesap ~6 MB avatar ve ~8 MB banner yükler (ikisi de
  doğrulamadan geçer). Artık sunucunun her üyesinin her `/lobby` açılışı hesap
  başına ~14 MB Postgres okuması ve RSC serileştirmesi demek. Beş hesap her
  sayfa görüntülemesine 100 MB+ ekler.
- **Etki:** lobby kullanılmaz hâle gelir; Node belleği ve CPU'su her istekte dev
  stringler kurar; `web` konteyneri OOM olursa tüm kurulum düşer.
- **Düzeltme:** resimleri gömmeyi bırak. Byte'ları sakla ve
  `GET /api/users/{id}/avatar?v=<hash>` gibi bir rotadan sun (doğru
  `Content-Type`, `nosniff`, `Content-Security-Policy: sandbox`, uzun cache).
  Liste payload'ından `bannerUrl`'ü çıkar, popover açılınca yükle. Yüklemede
  küçültüp yeniden kodla (avatar 512 px). "Lobby payload'ında `data:` yok" testi.

### HUB-001 — Dizin `instanceId`'si her kurulumda aynı (Orta)

- **Konum:** `packages/db/src/queries/instanceSettings.ts:6` (`DEFAULT_INSTANCE_ID = 'self-host'`,
  tüm satırlar), `:518` (aynı adla gölgelenen `'default'`), `:551`
  (`setDirectoryVerificationConfig` `'default'` satırını güncelliyor),
  `.well-known/lobbyforge-verification/route.ts:54-59`, `registryInstances.ts:150-156`.
- **Durum bugün:** kanıt üreten sorgu hiç var olmayan `'default'` satırını okuyor.
  Bu yüzden `.well-known` her kurulumda 404 dönüyor ve
  `POST /api/admin/directory/config` `{ok:true}` deyip hiçbir şey yazmıyor.
  **Yani dizin kaydı şu an hiçbir kurulumda çalışmıyor.** Bu rotaların testi yok.
- **Açık:** bariz tek satırlık düzeltme (`'self-host'` okumak) tüm kurulumların
  aynı `instanceId`'yi yayınlamasına yol açar. Bir hub hesabı
  `instanceId=self-host` için kendi alan adıyla kayıt olur; o andan sonra her
  gerçek kurulum "başka bir kullanıcı kaydetmiş" 403'ü alır ve o kimliğin
  heartbeat'leri saldırganın anahtarıyla doğrulanır. Saldırgan olmadan bile
  ikinci dürüst kurulum ilkiyle çakışır.
- **Düzeltme:** her kuruluma rastgele, kalıcı bir dizin kimliği ver (ya da kimliği
  ilk kayıtta anahtar parmak izine bağla). Satır sorgusunu düzelt;
  `setDirectoryVerificationConfig` 0 satır güncellerse hata versin. Gerçek
  sorguya giden route testleri ekle.

### Düşük önemdekiler

- **AUTH-002 — İptal edilen oturum sunucu tarafında oluşturulan sayfalarda çalışıyor.** İptal yalnızca
  `withApiSecurity`, ws-gateway ve SSE'de uygulanıyor. `app/lobby/page.tsx:605-606`,
  `app/layout.tsx:44` ve `lib/admin-auth.ts:28-40` (`isInstanceAdminAllowed`, tüm
  `app/admin/**` sayfaları) çerezi iptal kontrolü olmadan okuyor. Çalınmış ve
  sonra iptal edilmiş bir çerez, kendi süresi dolana kadar (en çok 60 dk) kanal,
  üye ve son mesajları; sahipse denetim günlüğü ve davet kodlarını görmeye devam
  ediyor. Ayrıca `api/admin/bandwidth/route.ts:27-29` oturumu `next/headers`
  `cookies()` ile okuyor: Next yinelenen çerezde **sonuncuyu**, sarmalayıcının
  `readCookie`'si **ilkini** alıyor. `Cookie: lf_guest=x; lf_guest=<iptal>` iptal
  kontrolünü atlıyor. Düzeltme: `getActiveSession()` = okuma + `isSessionRevoked`
  (üretimde fail-closed) yardımcısı, sayfalarda ve `isInstanceAdminAllowed`'da
  kullanılsın; bandwidth rotası `req.headers`'tan okusun; birden fazla `lf_guest`
  taşıyan istek reddedilsin.
- **AUTHZ-004 — Davet, "ilk katılımda onay" politikasını atlıyor.** `invites.ts:240-357`
  `server_access_policies`'i hiç okumuyor (kayıt rotası okuyor:
  `api/auth/register/route.ts:72-87`). Arayüz "yeni kimlikleri moderatör onayına
  kadar beklet" diyor. Onay kuyruğu olmadığı için ya katılımı reddet ya da ayarı
  kuyruk gelene kadar gizle; `/lobby` otomatik katılımında da uygula.
- **AUTHZ-005 — Profil görünürlüğü uygulanmıyor.** `profileVisibility` kaydediliyor
  (`settings/me/route.ts:26`) ama hiçbir okuyucu kullanmıyor; "Kimse" seçilse de
  bio, banner, avatar ve durum metni lobby payload'ında ve DM listesinde gidiyor.
  `applyPresencePrivacy` gibi bir projeksiyonla uygula ya da ayarı kaldır.
- **AUTHZ-006 — Susturulan üye ekran paylaşımı sesiyle konuşabiliyor.**
  `lib/voice-moderation.ts:49-58` yalnızca mikrofonu kaldırıyor; token
  `screen_share_audio` vermeye devam ediyor (`allowScreenShare: true` ve `STREAM`
  varsayılan). "Sistem sesini paylaş" ya da kaynak etiketini değiştiren bir
  istemci yeterli. Dinleyicinin yayını açması gerektiği için etkisi sınırlı.
  `timedOut || voiceMuted` iken `screen-share-audio`'yu da düşür.
- **PLUG-002 — Atılmış host etkinliği bitirebiliyor.** `activities/[sessionId]/end/route.ts:57-84`
  üyelik kontrol etmiyor; override'ı olmayan kanalda `canMemberAccessChannel` üye
  olmayana da `true` dönüyor ve `isHost` izin kontrolünü atlatıyor. GET, actions
  ve SSE üyelik istiyor, bu rota istemiyor. 71. satırdan önce sahip ya da
  `isServerMember` iste; test ekle.
- **HUB-002 — Listelenmiş dizin kaydı yeniden incelemesiz değiştirilebiliyor.**
  Kayıt varsa bile kanıtlar `body.publicKey`/`body.domain`'e karşı doğrulanıyor,
  saklı anahtar ya da alan adına değil; upsert ad, açıklama, etiket vb. alanları
  güncelliyor ve `isListed`/`isVerified`'a dokunmuyor. Yalnızca sahibin hub
  oturumuna sahip biri onaylı kaydı "LobbyForge Official Support" yapıp oltalama
  metni koyabilir. Kayıt varsa nonce imzasını saklı anahtarla doğrula, belgeyi
  saklı alan adından çek; gösterilen alanlar değişince listelemeyi incelemeye al.
- **HUB-003 — Bayat kayıtlar erişilebilir kalıyor.** `discover/[instanceId]` ve
  `discover/go` yalnızca `isListed`/`isBlocked`'a bakıyor, heartbeat tazeliğine
  bakmıyor. Alan adının süresi dolup başkası alırsa resmî hub "doğrulanmış" rozetli
  bir çıkış sayfasıyla onu gösterir. Admin paneli de bayat/bekleyen/engellenmiş
  kayıtları göremiyor (`listPublicRegistryInstances`). İki sayfada
  `HEARTBEAT_STALE_MS` uygula; adminlere tüm satırları veren bir sorgu ekle.
- **FILE-002 — Dizin doğrulama hatası iç ağı anlatıyor** (iki inceleyici ayrı ayrı
  buldu: FILE-002 = HUB-004). `api/directory/register/route.ts:76-82` ve
  `change-domain/route.ts:145-150` fetch hatasını aynen dönüyor:
  `domain=https://postgres` → "Target resolves to a blocked address: 172.20.0.4";
  bilinmeyen adlar `ENOTFOUND`; genel `host:port` hedeflerinde bağlantı/TLS hata
  farkları port taraması sağlıyor. SSRF bloğu tutuyor, sızan yalnızca keşif
  bilgisi. Dakikada 5 istek; misafir oturumu da yeterli ve rota self-host'ta da
  açık. Genel bir hata dön, ayrıntıyı logla; noktasız hostname'leri reddet;
  dizin yazma rotalarını resmî moda sınırla.
- **INFRA-002 — TURN gizli anahtarı yerel imaja giriyor.** `.dockerignore` render
  edilen `infra/turn/turnserver.conf`'u dışlamıyor; `install.sh` render'dan sonra
  `up -d --build` çalıştırıyor, `Dockerfile:6` `COPY . .` ile dosya `/app` altına
  `node` sahipliğinde giriyor. Plugin worker aynı imajı kullanıyor. Dinamik
  eklentiler açıkken kurulan bir marketplace eklentisi
  `/app/infra/turn/turnserver.conf`'u okuyup `static-auth-secret`'ı oyun durumuna
  yazabilir; sahibi istediği kullanıcı adı ve süreyle TURN kimliği basar.
  Render edilen dosyaları (`infra/turn/turnserver.conf`, `infra/livekit/livekit.yaml`,
  `infra/nginx/conf.d/*.conf`, `.install-staging.*`) dışla, tercihen
  `.dockerignore`'u izin listesine çevir; CI imajda `static-auth-secret` arasın.

## 4. Doğrulanması gerekenler

Bunlar orta güvenli: desen var ama sömürülebilirlik ortama ya da bir ürün
kararına bağlı.

| ID | Konum | Soru |
|---|---|---|
| INFRA-V-01 | `docker-compose.prod.yml:355-360` | Hedef Docker Engine'de `internal: true` köprüsü host'ta bir gateway adresi alıyor mu? Alıyorsa INFRA-001 relay'i Postgres 5432 ve Redis 6379'a da ulaşır (ikisi de şifreli). |
| PLUG-V-01 | `apps/plugin-worker/src/index.ts:144-150` | Executor çocuğu PID 1 ile aynı UID'de: `/proc/1/environ`'dan `PLUGIN_WORKER_TOKEN` okunabilir; `spawn({detached:true})` `kill(-pid)`'den kaçar. Worker `internal` ağda `web:3000`'e doğrudan ulaşıp `X-Forwarded-For` uydurabilir. (Ön koşul: operatörün kötü niyetli bir eklentiyi onaylaması.) Worker yalnızca depolama ucuna ulaşan kendi ağına alınmalı mı? |
| PLUG-V-02 | `apps/ws-gateway/src/authorize.ts:72-106` | Sohbet topic'leri `READ_MESSAGE_HISTORY` istemiyor, REST istiyor. Bu yetkisi olmayan üye canlı mesajları socket'ten almalı mı? |
| PLUG-V-03 | `activities/[sessionId]/stream/route.ts:107-110` | SSE açılışı IP başına dakikada 30 ile sınırlı ama kullanıcı başına eşzamanlı akış sınırı ve nginx `limit_conn` yok. |
| AUTHZ-V-01 | moderasyon rotaları | Timeout almış bir moderatör kick/ban/timeout/rol atama/mesaj silme yapabiliyor. Timeout moderasyon yetkisini de askıya almalı mı? |
| AUTHZ-V-02 | `api/dm/route.ts:57-75` | Herhangi bir hesap, ortak sunucu olmadan herhangi bir kullanıcı UUID'sine DM açabiliyor; resmî hub'da tek savunma engelleme. Bilinmeyen UUID 500 dönüyor (varlık sorgusu gibi çalışıyor). |
| AUTHZ-V-03 | `lib/turn-credentials.ts:29`, `infra/turn/turnserver.conf.template:53-60` | TURN kimlikleri 12 saat geçerli ve geri alınamıyor; banlanan kullanıcı her genel IP'ye relay tutabilir. `allowed-peer-ip` SFU adresine sabitlenmeli mi? |
| FILE-V-01 | `app/lobby/page.tsx:743,818,822,826` | React 19 Flight, büyük avatar/banner stringlerini birden fazla kez serileştiriyor mu? (FILE-001'in çarpanını belirler; 6 MB avatarlı bir üyeyle `/lobby` boyutu ölçülmeli.) |
| FILE-V-02 | `apps/web/lib/ip-pinned-https.ts:63-67` | `timeout` toplam süre değil, soket boşta kalma süresi. Saniyede bir byte gönderen bir host kayıt isteğini günlerce açık tutabilir mi? |
| HUB-V-01 | `apps/desktop/src-tauri/src/lib.rs:59-80,181-222,296-302` | `begin_desktop_login`'i hiçbir şey çağırmıyor, yani masaüstü giriş devri şu an çalışmıyor. Bağlanmadan önce: `forward_handoff` `{code,state}`'i `'*'` hedefiyle o anki sayfaya gönderiyor ve bekleyen kayıt `connect/disconnect_instance`'ta temizlenmiyor. Webview origin'i `pending.instance_origin` ile karşılaştırılmalı. |
| HUB-V-02 | `lib.rs:306-419` | `on_navigation` / `on_new_window` yok. Bir instance sayfası ana pencereyi yabancı bir origin'e götürebilir mi? Pencere başlığı değişmediği ve adres çubuğu olmadığı için yabancı sayfa instance gibi görünür ve global PTT mesajlarını alır. |
| AUTH-V-01 | `lib/security-headers.ts:235-237` | `LOBBYFORGE_TRUSTED_PROXY=cloudflare` (`docs/WEB_APP.md:185`) paketli nginx ile güvensiz: nginx istemcinin `CF-Connecting-IP`'sini aynen geçiriyor. Belgelenen yol (`docs/DEPLOY_CLOUDFLARE.md`, real_ip + `x-forwarded-for`) doğru; `cloudflare` modu kaldırılmalı ya da nginx bu başlığı silmeli. |

Bağımlılıklar: yerelde `pnpm audit --prod` npm'in audit ucunda ECONNRESET
verdi (iki inceleyicide de). CI'daki üretim bağımlılık denetimi `38945b6`
üzerinde yeşil (2026-09-29). GitHub'da Dependabot **uyarıları kapalı**
(sürüm güncellemeleri açık); açılması önerilir.

## 5. Eylül düzeltmelerinin durumu

| Eylül bulgusu | Durum |
|---|---|
| S1 MANAGE_ROLES → ADMINISTRATOR | ✅ Tutuyor (verilemez yetki kontrolü, rütbe kuralları) |
| S2 Ban erişimi kesmiyor | ✅ Tutuyor. Ama ayrılan kişi banlanamıyor (AUTHZ-002) |
| S3 `/lobby` gizli kanal sızıntısı | ✅ Tutuyor |
| S4 Ses moderasyonu LiveKit'e yansımıyor | ✅ Mikrofon için tutuyor; ekran paylaşımı sesi açık (AUTHZ-006) |
| S5 Presence gizliliği | ✅ Tutuyor |
| S6 WS gateway Redis bağlantı patlaması | ✅ Tutuyor |
| S7 Şifre değişikliği oturumları iptal etmiyor | ⚠️ Kayıtlı oturumlar için tutuyor; önceden alınmış masaüstü kodu yolu açık (AUTH-001) |
| S8 Sesli kanalda ad taklidi | ✅ Tutuyor |
| S9 İmaja gizli dosya girmesi | ⚠️ Anahtar/yedek/sertifika için tutuyor; render edilen TURN ayarı giriyor (INFRA-002) |
| S10 change-domain yeniden onay | ✅ Tutuyor; ama ad/açıklama değişikliği onaysız (HUB-002) |
| S11 Anonim anket | ⚠️ Durum projeksiyonunda tutuyor; denetim günlüğünden aşılıyor (PLUG-001) |
| V6 Masaüstü postMessage | ✅ Tutuyor |
| V7 Build-time `NEXT_PUBLIC_*` | ✅ Tutuyor (CI kontrolü var) |
| coturn IPv6 CIDR | ✅ Şablon doğru; ama dosya okunamıyor (INFRA-001) |

## 6. Sağlam bulunan alanlar

- **Oturum:** HMAC-SHA256 imzalı çerez, sabit zamanlı karşılaştırma, `exp`
  zorunlu, ≥32 karakter gizli anahtar ve hiçbir yerde geri dönüş değeri yok.
  `lf_guest` HttpOnly, SameSite=Lax, üretimde Secure. Her giriş yolu yeni gid
  üretiyor (session fixation yok). Oturumlar çerez verilmeden önce kaydediliyor
  ve üretimde fail-closed.
- **CSRF/Origin:** tüm `app/api` rotaları sarılı; eksik Origin, `null` ve
  `sec-fetch-site: cross-site` reddediliyor. Durum değiştiren GET yok.
- **Şifreler:** scrypt (N=16384, r=8, p=1), 16 byte tuz, bilinmeyen kullanıcıda
  sahte hash, genel hata mesajları; zamanlamaya dayalı hesap tespiti yok.
- **Kurulum, OAuth, admin:** setup token SHA-256 + timingSafeEqual, advisory lock.
  Google OAuth 256-bit state, JWKS ile ID token doğrulaması, hesaplar e-postayla
  bağlanmıyor. Tüm `/api/admin/*` rotaları `requireInstanceAdmin`'den geçiyor.
  Test-sıfırlama rotaları üretimde kapalı.
- **CSP ve başlıklar:** nonce tabanlı `script-src`, üretimde `unsafe-eval` yok,
  tek `frame-src` origin'i, `frame-ancestors 'none'`, `object-src 'none'`,
  HSTS, `nosniff`.
- **Yetkilendirme:** kick/ban/timeout/susturma/rol atama aynı hiyerarşi
  modelinden geçiyor; sunucular arası id karıştırma her yerde reddediliyor;
  LiveKit token'ında kimlik, ad ve metadata sunucuda belirleniyor;
  `canUpdateOwnMetadata` verilmiyor.
- **Gizli oyun durumu:** her durum yolu (GET, aksiyon yanıtı, SSE, ws-gateway)
  `projectActivityState`'ten geçiyor; bus durum taşımıyor; altı eklentinin gizli
  alanları doğru projekte ediliyor; aktör alanları oturumdan yazılıyor;
  rastgelelik sunucuda; bitmiş oturuma aksiyon gönderilemiyor.
- **Eklenti kurulumu:** yalnızca admin; onaylı katalog + sha256 ve boyut pini;
  IP-pinli HTTPS (yönlendirme yok); tar taramasında giriş tipi, boyut, sayı ve
  symlink kontrolü; executor çocukları `env:{}` ile çalışıyor; topluluk
  eklentilerinin `renderClient`'ı tarayıcıda hiç çalışmıyor.
- **Botlar:** token'lar dinlenimde hash'li ve sabit zamanlı karşılaştırılıyor;
  bot başına hız sınırı; yalnızca kendi sunucusunun kısıtsız metin kanalları;
  `@everyone`/`@here` engelli; üyeler BOT rozetini taklit edemiyor.
- **İçerik gösterimi:** `dangerouslySetInnerHTML`, `innerHTML`, `srcDoc` yok;
  her şey React metni; linkify/markdown/önizleme yok. Görsel yükleme yalnızca
  PNG/JPEG/GIF/WebP, magic byte eşleşmesi, boyut sınırı; SVG reddediliyor.
- **SSRF:** dizin doğrulama, eklenti inceleme ve kurulum IP-pinli taşıma
  kullanıyor; doctor, güncelleme manifesti, OAuth ve GitHub yıldız isteği
  sabit/env URL'leri kullanıyor.
- **Dizin:** hesaba bağlı nonce, `.well-known` kanıtı, Ed25519 heartbeat (±300 sn,
  nonce saklama), change-domain ve rotate-key eski anahtar imzası istiyor;
  listeleme çıktısında `javascript:` URL'si mümkün değil.
- **Masaüstü:** Tauri 2.11.5 ACL'de `remote` girdisi yok, uzak sayfalar komut
  çağıramıyor; yerel CSP `script-src 'self'`; deep link state'i sabit zamanlı
  karşılaştırılıyor.
- **Altyapı:** imajlar digest ile sabitli, çalışma zamanı root değil, Postgres ve
  Redis yayınlanmıyor ve şifreli, plugin worker salt-okunur + tüm yetkiler
  düşürülmüş + yalnızca iç ağ. nginx `X-Forwarded-For`'u `$remote_addr`'a
  eşitliyor ve `/api/internal/`'a 404 veriyor. `lfctl` Ed25519 imzası, digest
  pini, sürüm düşürme koruması, shell'siz sabit komutlar, her uygulamada
  doğrulanmış yedek. CI'da `pull_request_target` yok, release action'ları SHA ile
  sabitli, provenance ve SBOM üretiliyor. Git geçmişinde (228 commit) özel anahtar
  ya da gerçek `.env` yok.

## 7. Sertleştirme önerileri (açık değil, önceliğe göre)

1. **CI izinleri ve sabitleme:** `ci.yml`, `security.yml`, `desktop-release.yml`
   action'ları etiketle (`@v4`, `@v0`, `@stable`) kullanıyor ve `permissions:`
   bloğu yok; bu işler release'in okuduğu GHA cache'ine yazıyor. SHA ile sabitle,
   `permissions: contents: read` ekle. `release.yml`'deki `desktop` ve
   `github-release` işlerine kendi dar izinlerini ver; `LF_RELEASE_SIGNING_KEY`'i
   yalnızca `v*` etiketlerine açık korumalı bir Environment'a taşı.
2. **Sürüm imzalama anahtarı** hâlâ `infra/keys/release-ed25519-private.pem`
   altında, repo kopyasının içinde (Eylül'den açık). Repo dışına taşı.
3. **Hesap başına giriş sınırı:** login ve masaüstü girişi ayrı IP kovaları
   kullanıyor (IP başına 15 dakikada 20 deneme, hesap başına sınır yok). E-postaya
   bağlı ortak bir hata sayacı ekle.
4. **Mutlak oturum ömrü:** `POST /api/auth/guest` oturumu sonsuza kadar
   uzatabiliyor; örneğin 30 günlük üst sınır koy. `revokeOtherSessions` hata
   verirse şifre değişikliği başarılı sayılmasın.
5. **Üretimde güvensiz varsayılanları reddet:** `LOBBYFORGE_TRUSTED_PROXY`
   yoksa yalnızca uyarı veriliyor (tüm istemciler tek kova, biri herkesi
   kilitleyebilir). Dev/e2e compose'daki bilinen değerler (`devkey`/
   `devsecret_please_change`, `dev_session_secret_…`) `NODE_ENV=production`
   altında reddedilsin; dev portları `127.0.0.1`'e bağlansın.
6. **Plugin worker:** executor'ları ayrı UID'de çalıştır ve süreç grubu yerine
   cgroup ile öldür; worker'ı yalnızca depolama ucuna ulaşan bir ağa al;
   `x-lf-worker-token`'ı sabit zamanlı karşılaştır.
7. **Bot ve yetki boşlukları:** bot token'ını döndürmek o botun tüm yetkilerini
   devrediyor; döndüreni o yetkileri verebilecek biriyle sınırla.
   `PATCH /bots/{id} {enabled:true}` Moderation Bot'u `MANAGE_MESSAGES` kontrolü
   olmadan açıyor. Uygulama ayarlarındaki `allowedChannelIds`/`allowedRoleIds`
   saklanıyor ama etkinlik başlatılırken uygulanmıyor.
8. **Diğer:**
   - ws-gateway istemciye `err.message` dönüyor (Drizzle hataları SQL içerir).
   - Hushle çekilişi, takım kimlikleri ve zar `Math.random` kullanıyor; Vampire
     Village gibi kripto RNG'ye geç.
   - `presence` POST, sahte `bandwidthDeltaBytes` ile admin bant genişliği
     alarmını tetikletebiliyor.
   - Yüklenen görseller sunucuda yeniden kodlansın (EXIF/GPS, polyglot ve
     decoder bombası temizlenir).
   - `fetchIpPinned`'a toplam süre sınırı eklensin.
   - `isBlockedNetworkIp` `::/96` ve 6to4'ü (`2002::/16`) de engellesin.
   - Tar taramasında ustar `prefix` alanı da kontrol edilsin.
   - Yedek dizini 0700, dosyaları 0600 olsun.
   - `lfctl apply`'da açık anahtar yoksa durulsun.
   - `/api/directory/*` yazma rotaları resmî moda sınırlansın.

## 8. Rakip kıyaslaması

LobbyForge hücreleri belgelerden değil koddan okundu; rakip bilgileri
Ekim 2026 itibarıyla web araştırmasından geliyor (kaynaklar bölüm sonunda).
Guilded 19 Aralık 2025'te kapandı ve tablo dışında. Spacebar ve Steam Chat
için güvenilir veri az olduğundan tabloya alınmadı.

### Konumlanma

**Gerçekten farklı olduğu yerler**
- **Sesli odada çalışan oyunlar.** Oyun durumu sunucuda tutuluyor ve her
  izleyiciye yalnızca görmesine izin verilen kısmı gidiyor; gizli rol ve kart
  hile ile okunamıyor. Tek bir eklenti SDK'sıyla altı bitmiş oyun var. En yakın
  karşılığı Discord Activities, o da kendi sunucunda barındırılamıyor. Açık
  kaynak tarafta benzeri yok (Matrix'te widget, Zulip'te bir trivia widget'ı var).
- **Kendi sunucunu işletmek alışılmadık derecede iyi çözülmüş:** imzalı ve
  digest'e sabitli güncelleme, öncesinde doğrulanmış yedek, geri alma, Doctor
  sağlık/kapasite sayfası, CI'da yedekten geri yükleme testi. Karşılaştırma için:
  Stoat'un resmî uygulamaları çoğunlukla kendi sunucuna bağlanamıyor; Element
  Kubernetes/Helm istiyor ve 2025'ten beri kendi barındıranlar çağrı altyapısını
  da kendileri kurmak zorunda.
- **Davetle tek tıkla misafir olarak sesli odaya katılma** ve Türkçe öncelikli
  arayüz. Discord Ekim 2024'ten beri Türkiye'de erişime kapalı.
- **Zamanlama:** Discord küresel yaş doğrulamasını 23 Eylül 2026'da açtı;
  Guilded kapandı; TeamSpeak 6 sunucu lisansları 1 Aralık 2026'da doluyor.

**Geride olduğu yerler**
- **Temel metin sohbeti:** dosya yükleme, tepki (reaction), Markdown, thread,
  bağlantı önizlemesi yok; son 50 mesajın gerisine kaydırılamıyor.
- **Mobil uygulama ve push bildirimi yok.**
- **Şifre sıfırlama, e-posta doğrulama ve 2FA yok.**
- **İnce bot platformu:** webhook, slash komutu ve olay akışı yok; botlar
  polling yapıyor.
- **Masaüstü uygulaması** imzasız bir alfa, otomatik güncelleyici yok.
- **Yalnızca iki dil** (en, tr).
- **E2EE yok;** Discord 1 Mart 2026'dan beri sesli/görüntülü aramalarda
  zorunlu E2EE kullanıyor.
- **En yakın doğrudan rakip Stoat** (eski Revolt): o da AGPL ve Discord benzeri,
  2026'dan beri ses ve görüntü, ~135 dil, mobil uygulamalar. Ses öncelikli en
  yakın rakip TeamSpeak 6, ama kapalı kaynak ve sunucusu hâlâ beta.

### Karşılaştırma tablosu

✓ var · kısmi · ✗ yok · ? doğrulanamadı · ᶜ uzun süredir var, yeniden kontrol edilmedi.
L-notları tablonun altında.

| Yetenek | **LobbyForge** | Discord | Stoat | Matrix/Element | Mumble | TS6 (beta) | Rocket.Chat | Zulip | Mattermost |
|---|---|---|---|---|---|---|---|---|---|
| Gürültü engelleme | kısmi L1 | ✓ Krisp | ✓ RNNoise | ✓ tarayıcı | ✓ RNNoise | ✓ | ? | n/a | ? |
| Bas-konuş (PTT) | ✓ L2 | ✓ | ✗ | kısmi | ✓ᶜ | ✓ᶜ | ✗ | n/a | ? |
| Ekran paylaşımı | ✓ (4K60'a kadar) | ✓ | ✓ 720p30 | ✓ | ✗ | ✓ 4K | kısmi | kısmi | kısmi |
| Görüntü | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | kısmi (Jitsi) | kısmi | kısmi |
| Sahne / etkinlik takvimi | ✗ L5 | ✓ | ✗? | ✗? | ✗ | ✗ | ✗? | ✗? | ✗? |
| Thread | ✗ | ✓ | ✗? | ✓ | ✗ | ✗ | ✓ᶜ | ✓ (topic) | ✓ᶜ |
| Yanıt | kısmi L7 | ✓ | ✓ | ✓ | ✗ | kısmi | ✓ | ✓ | ✓ |
| Tepki | ✗ L8 | ✓ | ✓ | ✓ | ✗ | kısmi | ✓ | ✓ | ✓ |
| Arama | kısmi L10 | ✓ | ✓ | kısmi | ✗ | ? | ✓ | ✓ | ✓ |
| Dosya paylaşımı | ✗ L12 | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Bağlantı önizlemesi | ✗ | ✓ | ✓ | ✓ | ? | ? | ✓ | ✓ | ✓ |
| Markdown | ✗ | ✓ | ? | ✓ | kısmi | ? | ✓ | ✓ | ✓ |
| Anket | ✓ (oyun) | ✓ | ✗? | ✓ | ✗ | ✗ | kısmi | ✓ | ✗ |
| AutoMod | ✓ L16 | ✓ (+AI) | ✗ (planlı) | kısmi (Draupnir) | ✗ | ✗ | ? | kısmi | ✗? |
| Timeout / ban / denetim günlüğü | ✓ | ✓ | ✓ | kısmi | kısmi | kısmi | kısmi | kısmi | kısmi |
| Topluluk içi şikâyet | ✗ L20 | ✓ | ✓ | ✓ | ✗ | ? | ✓ | ✓ | kısmi |
| Yavaş mod | ✗ | ✓ | ✓ | ✗? | ? | kısmi | ? | ✗ | ✗? |
| Kanal başına izin | kısmi L23 | ✓ | ✓ | ✓ | ✓ ACL | ✓ | kısmi | ✓ | kısmi |
| Bot / webhook / slash | kısmi L24 | ✓ | kısmi | ✓ | kısmi | kısmi | ✓ | ✓ | ✓ |
| Oyun / etkinlik | ✓ L25 | ✓ | ✗ | kısmi | ✗ | ✗ | kısmi | kısmi | kısmi |
| Mobil uygulama | ✗ L26 | ✓ | kısmi | ✓ | kısmi (3. taraf) | ✗ | ✓ | ✓ | ✓ |
| Masaüstü uygulama | kısmi L27 | ✓ | ✓ | ✓ | ✓ | ✓ beta | ✓ | ✓ | ✓ |
| Federasyon | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | kısmi |
| E2EE | ✗ | ✓ ses/görüntü | ✗ | ✓ varsayılan | ✗ | ✗? | kısmi | ✗ | ✗? |
| Kendi barındırma zahmeti | düşük–orta L30 | n/a | orta | yüksek (Helm) | çok düşük | düşük (Docker) | düşük | düşük | düşük |
| Lisans | AGPL-3.0 | kapalı | AGPL-3.0 | AGPL-3.0 (+ticari) | BSD-3 | kapalı | MIT + ee | Apache-2.0 | AGPL/MIT + ee |
| Dil sayısı | 2 | 31 | ~135* | 98* | ~45 | ? | 65–80 | 25 | 20 |
| Erişilebilirlik | kısmi L33 | ✓ | ? | kısmi | ✓ | ? | ✓ WCAG AA | ? | ? |
| Kullanıcı veri dışa aktarma | ✗ L34 | ✓ | ✗? | ✓ | n/a | ? | ? | ✓ | ? |
| Push bildirimi | kısmi L35 | ✓ | kısmi | ✓ | kısmi | ? | kısmi | kısmi | kısmi (ücretli) |
| Keşif / dizin | ✓ beta L37 | ✓ | ✓ | ✓ | ✓ᶜ | ✓ | n/a | ✓ | n/a |
| Gelir modeli | yok | Nitro, abonelik, mağaza | bağış | ESS / Synapse Pro | yok | lisans | ücretli plan | Cloud/destek | ücretli plan |

\* Kısmen çevrilmiş diller dahil.

**LobbyForge notları (koddan):**
- **L1:** Yalnızca tarayıcının yerleşik gürültü/yankı/kazanç ayarları
  (`LobbyVoiceProvider.tsx:207-209`). "Ses izolasyonu" anahtarı kaydediliyor ama
  çağrıya hiç uygulanmıyor.
- **L2:** Tarayıcıda sekme odaktayken, masaüstünde global (Ctrl+Space); yalnızca
  Windows'ta doğrulandı. Sunucu PTT'yi zorunlu kılabiliyor.
- **L5:** `stage` kanal tipi var ama sesli kanal gibi davranıyor; zamanlanmış
  etkinlik yok.
- **L7:** `replyToId` API ve veritabanında var, yanıt arayüzü yok.
- **L8:** `reactions` tablosu ve `add_reactions` izni var, ama API rotası ve
  arayüz yok.
- **L10:** Arama yalnızca yüklü 50 mesajı süzüyor (`LobbyMainArea.tsx:316`);
  API `before=` sayfalamayı destekliyor ama arayüz kullanmıyor.
- **L12:** `attachments` tablosu ve depolama admin sayfası var; ek, GIF ve hediye
  düğmeleri devre dışı. Yalnızca avatar ve banner yüklenebiliyor.
- **L16:** Moderation Bot: Türkçe duyarlı yasaklı kelime (benzer harfleri
  yakalıyor), bağlantı, toplu mention, flood ve tekrar. Kanal başına yavaş mod yok.
- **L20:** Yalnızca dizin kaydı şikâyeti var (`instance_reports`); üyeler
  birbirini engelleyebiliyor.
- **L23:** ~20 izin, üye başına çoklu rol. Kanal düzeyinde yalnızca görünürlük
  var; kanal başına izin/yasak override'ı yok.
- **L24:** Bot API v1 mesaj okuyup yazabiliyor, botlar polling yapıyor; olay,
  webhook ve slash komutu yok.
- **L25:** Hushle, Quiz, Vampire Village, Watch Party, Poll, Dice Bot.
  Marketplace eklentileri henüz kendi arayüzünü çizemiyor (ADR-002) ve sandbox
  düşmanca kod için güvenli değil (ADR-001).
- **L26:** Yalnızca duyarlı web (`MobileNav.tsx`); PWA manifest'i ve service
  worker yok.
- **L27:** Tauri 2, imzasız, otomatik güncelleyici yok; macOS/Linux test edilmedi.
- **L30:** `git clone` + `install.sh`, ~9 Docker servisi, UDP 50000–60000 açık
  olmalı, yalnızca amd64; güncellemeleri `lfctl` yapıyor.
- **L33:** Azaltılmış hareket, yüksek kontrast, büyük metin, odak halkası
  ayarları ve ~320 aria özniteliği; otomatik erişilebilirlik testi yok (axe kurulu
  değil).
- **L34:** `lfctl backup` tüm sunucuyu yedekliyor; kullanıcı kendi verisini dışa
  aktaramıyor ya da hesabını silemiyor (`softDeleteUser` var ama çağıran yok).
- **L35:** Yalnızca sekme açıkken tarayıcı bildirimi ve okunmamış noktaları.
- **L37:** Alan adı doğrulaması, heartbeat, doğrulanmış rozeti, filtre ve şikâyet
  var; henüz gerçek sunucu listelenmiyor (bkz. HUB-001: kayıt şu an çalışmıyor).

## 9. Özellik açıkları ve öneriler

### Etkisi en yüksek açıklar

Hedef kitle: kendi sunucusuna sahip olmak isteyen oyun/ses toplulukları.
Efor tek geliştirici için: S < 1 hafta, M 1–3 hafta, L > 1 ay.

| # | Açık | Neden önemli | Efor | Kodda nerede |
|---|---|---|---|---|
| 1 | **Temel sohbet:** tepki, yanıt arayüzü, Markdown, dosya yükleme, bağlantı önizlemesi, eski mesajları yükleme | Topluluk günün çoğunu metinde geçiriyor; Mumble ve Steam dışında her rakipte var | M (tablolar, izin ve depolama sayfası hazır) | `…/messages/[messageId]/reactions` rotası, yükleme rotası + `lib/upload-quota.ts`, `LobbyLiveRoster.tsx`, Composer. FILE-001 düzeltmesiyle aynı dosya sunma rotası kullanılmalı |
| 2 | **Mobil erişim ve push** | Oyun geceleri telefondan organize ediliyor; iOS'ta web push yalnızca Ana Ekran'a eklenmiş sitelerde çalışıyor | PWA + Web Push M, yerel uygulama L | `app/manifest.ts`, service worker, `packages/db`'de push abonelik tablosu, `lib/chat-bus.ts` / `dm-bus.ts` |
| 3 | **Hesap kurtarma ve güvenlik + yasal kullanıcı hakları:** şifre sıfırlama (e-posta gerekir), e-posta doğrulama, 2FA/passkey, veri dışa aktarma ve hesap silme | Hesap kaybı en sık destek talebi; KVKK/GDPR hakları zorunlu | M | `app/api/auth/*`, yeni `app/api/users/me`, `settings/my-account`; Mailpit dev compose'da var |
| 4 | **Açık topluluklar için moderasyon:** şikâyet düğmesi ve kuyruk, yavaş mod, kanal başına izin/yasak, katılım kapıları (doğrulanmış e-posta, hesap yaşı), baskın kilidi, ban'da mesaj silme | Herkese açık sunucular bunlar olmadan spam'e dayanamaz | M | `channel_role_overrides`'a izin setleri, `message_reports` tablosu, `admin/moderation`, `lib/bots/moderation*.ts` |
| 5 | **Gerçek gürültü engelleme** ve çalışmayan ses izolasyonu anahtarı | Discord, Stoat, Mumble, TS6 hepsinde var. LiveKit'in Krisp filtresi yalnızca LiveKit Cloud'da; kendi sunucuda tarayıcıda RNNoise/DeepFilterNet gerekiyor | S–M | `LobbyVoiceProvider.tsx` track processor, `lib/voice-video-preferences.ts` |
| 6 | **Dağıtıma hazır masaüstü:** kod imzalama ve notarization, `tauri-plugin-updater`, yerel bildirim, macOS/Linux PTT doğrulaması | İmzasız uygulama SmartScreen/Gatekeeper'da duruyor | M (çoğu sertifika ve CI) | `apps/desktop/src-tauri/*`, `desktop-release.yml` |
| 7 | **Bot platformu v2:** olay akışı, gelen webhook (oyun sunucusu, Twitch, GitHub), slash komutları | Oyun toplulukları entegrasyonla yaşıyor | M–L | `app/api/bot/v1/*`, ws-gateway'de bot kimlik doğrulaması, `packages/bot-sdk` |
| 8 | **Sunucu tarafı arama** (Postgres tam metin indeksi) | Mevcut arama yalnızca son 50 mesajı görüyor | S–M | `packages/db` migration + `queries/messages.ts` |
| 9 | **Discord'dan içe aktarma:** kanal, rol, izin (mümkünse mesaj) | Yaş doğrulaması yüzünden Discord'dan ayrılmanın maliyetini düşürür | M | `lfctl import discord` ya da admin sayfası |
| 10 | **Zamanlanmış etkinlik ve gerçek sahne** (konuşmacı/dinleyici) | Turnuva ve topluluk geceleri için | M (sunucu susturması zaten LiveKit yayın iznini yönetiyor) | `lib/voice-moderation.ts`, `livekit/token`, `channels.type='stage'` |
| 11 | **Daha fazla dil** (es, de, pt-BR, ru, fr) ve Weblate | 2 dil, rakiplerin çok gerisinde | Dil başına S (`pnpm i18n:add` hazır) | `apps/web/messages/*`, `plugins/*/locales` |
| 12 | **Önce özel sesli odalar, sonra DM için E2EE** | Discord'da artık varsayılan | Ses M, metin L | LiveKit `e2ee` seçeneği + anahtar dağıtımı |

### Öne çıkaracak fikirler (eşitliğin ötesinde)

1. **Sesi yöneten oyunlar.** Gece vampirlere özel sesli alt oda, Hushle'da takım
   sesi, elenen oyuncunun yalnızca dinleyebilmesi. LobbyForge sunucu susturması
   için LiveKit izinlerini zaten canlı değiştiriyor; Discord Activities bunu
   yapamıyor.
2. **Marketplace'i tamamlamak.** Eklentilerin kendi arayüzünü sandbox'lı bir
   iframe'de çizmesi (ADR-002) ve sahte bir ses sunucusuyla yerel eklenti
   oyun alanı.
3. **Dizinde "devam eden oyuna katıl".** İsteyen sunucular lobisinde oyun olan
   herkese açık odaları ilan eder, herkes misafir olarak katılır (heartbeat ve
   misafir erişimi hazır).
4. **Kendi barındırılan oyun sunucuları için kontrol paneli.** Minecraft/CS2/
   Valheim durum kanalları, rollerle eşitlenen whitelist, oyun sunucusu açılınca
   kendiliğinden açılan sesli oda (Bot API v2 + webhook üzerine).
5. **Geçici sesli odalar ve takım arama (LFG) panosu.** İlan, oyunu seçili bir
   sesli oda yaratır; geçici odalar zaten backlog'da.
6. **Topluluğu taşıyabilmek bir satış argümanı.** Doctor'da görünen zamanlanmış,
   şifreli, site dışı yedekler ve başka bir LobbyForge sunucusunun içe
   aktarabileceği imzalı topluluk dışa aktarımı.
7. **Sunucular arası paylaşılan ban listeleri.** Hub üzerinden imzalı listelere
   abonelik (Matrix'in Draupnir politika listelerine benzer); "küçük sunucu
   spam'le tek başına baş edemez" sorununa cevap.
8. **Yayıncı modu ve OBS overlay'i.** Konuşanları ve canlı oyun skor tablosunu
   gösteren bir tarayıcı kaynağı (backlog'da).
9. **Sunucuda kalan ses kalitesi izleme.** Oda başına jitter ve paket kaybı, TURN
   kullanım oranı, Prometheus metrik ucu (TS6 beta13'te ekledi).

## 10. Lansman öncesi kontrol listesi

"Var" repo'nun karşıladığını, "Eksik" eklenmesi ya da kontrol edilmesi
gerekeni gösterir.

**Güvenlik**
- Var: CSP/HSTS, CSRF ve Origin kontrolü, fail-closed hız sınırları, imzalı ve
  sabitli güncellemeler, CodeQL/Trivy/RustSec taramaları, branch koruması,
  hash'e sabitli eklentiler, hash'li bot token'ları, sesi de kesen ban/timeout.
- Eksik:
  - [ ] Bu raporun P0 listesi (§11), özellikle INFRA-001.
  - [ ] Sahip ve adminler için 2FA, şifre sıfırlama, açık kayıtta captcha.
  - [ ] Sürüm imzalama özel anahtarını repo klasöründen taşımak.
  - [ ] Yayından önce GitHub yönetişimini kilitlemek (ADR-004); Dependabot
        uyarılarını açmak.
  - [ ] `SECURITY.md`'yi güncellemek: hâlâ "henüz etiketli sürüm yok" diyor,
        oysa rc.7 çıktı.
  - [ ] Dış bir güvenlik incelemesi.
  - [ ] `LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED` kapalı kalsın ya da yalnızca
        incelenmiş eklentilerle açılsın.

**Gizlilik ve veri koruma (KVKK/GDPR)**
- Var: telemetri yok, arama motoru indekslemesi varsayılan kapalı, yalnızca
  zorunlu çerezler, YouTube no-cookie oynatıcı.
- Eksik:
  - [ ] Kullanıcının kendi verisini dışa aktarması ve hesabını silmesi.
  - [ ] Mesajlar, denetim günlüğü ve `user_sessions`'taki IP adresleri için
        saklama süreleri.
  - [ ] Verinin gittiği üçüncü tarafların listesi (Google OAuth, YouTube,
        kullanılıyorsa Cloudflare, güncelleme kontrolü için GitHub).
  - [ ] KVKK aydınlatma metni (VERBİS muafiyeti olsa da zorunlu); hub yurt
        dışında barındırılıyorsa yurt dışına aktarım notu.

**Yasal sayfalar**
- Var: Watch Party oynatıcısının altında telif uyarısı.
- Eksik:
  - [ ] Kullanım Koşulları, Gizlilik Politikası, Kabul Edilebilir Kullanım,
        belirlenmiş temsilci ve tekrar eden ihlal politikasıyla Telif/DMCA
        sayfası.
  - [ ] Marketplace yayıncı koşulları ve dizin listeleme politikası.
  - [ ] İletişim/künye ve `/.well-known/security.txt`.
  - Hub altbilgisinde bunların hiçbiri yok, oysa hub artık hesap açılışı ve
    şikâyet alıyor.
  - YouTube API koşulları yayınlanmış bir gizlilik politikası istiyor (istenen
    `strict-origin-when-cross-origin` referrer politikası zaten ayarlı).
  - [ ] Her sunucu sahibi veri sorumlusu olduğu için sahiplere şablon yasal
        sayfalar.

**Platform düzenlemeleri**
- Eksik:
  - [ ] **AB DSA:** bildirim-ve-işlem, gerekçe bildirimi ve iletişim noktası
        tüm barındırma hizmetleri için geçerli (küçük şirket muafiyeti yalnızca
        ek platform yükümlülüklerini kapsıyor).
  - [ ] Koşullarda asgari yaş.
  - [ ] Birleşik Krallık kullanıcıları bekleniyorsa Online Safety Act risk
        değerlendirmesi.
  - [ ] "LobbyForge" için marka araştırması (Revolt, marka ihtarı yüzünden
        Stoat'a dönüşmek zorunda kaldı).

**Kötüye kullanım**
- Var: engelleme, ban, timeout, kick, Moderation Bot, admin incelemeli dizin
  şikâyetleri, eklenti inceleme kuyruğu, denetim günlükleri.
- Eksik:
  - [ ] Topluluk içinde şikâyet.
  - [ ] Yükleme açılmadan önce CSAM politikası ve bildirim yolu.
  - [ ] Kimin DM atabileceğini seçme (bugün herkes herkese DM açabiliyor;
        AUTHZ-V-02).
  - [ ] Misafirlere özel hız sınırları ve baskın kilidi.
  - [ ] Hub'da kötüye kullanım iletişim adresi.

**Yedekler**
- Var: `lfctl backup`/`restore`, CI'da geri yükleme testi, her güncellemeden
  önce otomatik yedek.
- Eksik:
  - [ ] Zamanlanmış, site dışı, şifreli ve döngülü yedekler.
  - [ ] `.env.prod`, TLS sertifikaları ve (açılınca) yüklenen dosyaların yedeği.
  - [ ] Belirtilmiş RPO/RTO. Migration'lar yalnızca ileri gidiyor; güncellemeyi
        geri almak yedekten dönmek demek.

**İzleme**
- Var: Doctor, `/api/health`, kapasite tahmini, bant genişliği sayfası.
- Eksik:
  - [ ] Prometheus metrik ucu; disk, sertifika süresi, LiveKit/TURN düşmesi
        için alarm.
  - [ ] Docker log rotasyonu.
  - [ ] İsteğe bağlı kendi barındırılan hata izleme.
  - [ ] TURN için gerçek bir Allocate denemesi yapan sağlık kontrolü (bugünkü
        TCP kontrolü INFRA-001'i göremedi).

**Ölçek sınırları**
- Var: realtime abonelik sınırları, k6 yük testi betiği.
- Eksik:
  - [ ] TURN relay port aralığı hâlâ 41 port (49160–49200); ~10 TURN
        kullanıcısının üstünde tükenebilir.
  - [ ] LiveKit bridge modda 10.001 UDP portu yayınlıyor.
  - [ ] Yalnızca amd64 imaj, tek VPS, tek LiveKit düğümü.
  - [ ] Yük testini koşup sayıları yayınlamak.

**Erişilebilirlik**
- Var: erişilebilirlik ayarları sayfası, temaya uyan oyun UI kiti, renk tek
  başına sinyal olarak kullanılmıyor.
- Eksik:
  - [ ] CI'da axe kontrolleri.
  - [ ] Ses ve oyunlar için ekran okuyucu ve yalnızca klavye turu.
  - [ ] Erişilebilirlik uygunluk beyanı.

**Kayıtlı sürüm engelleri**
- [ ] Gerçek bir VPS'te temiz kurulum (DNS + Let's Encrypt). Bu kurulum
      INFRA-001'i de yakalardı.
- [ ] macOS ve Linux'ta masaüstü PTT, kod imzalama.
- [ ] UDP'yi engelleyen bir ağdan TURN testi (`BETA_RELEASE.md`).

**Çalışmayan şey vaat eden arayüz** (yayından önce yap ya da gizle)
- [ ] Devre dışı ek, GIF ve hediye düğmeleri.
- [ ] Hiçbir şey yapmayan ses izolasyonu anahtarı.
- [ ] Giriş tasarımındaki "Şifremi unuttum?" yeri.
- [ ] "Yakında" diye işaretli bot izinleri.
- [ ] Uygulanmayan "Profil görünürlüğü" ayarı (AUTHZ-005) ve onay kuyruğu
      olmayan "ilk katılımda onay" seçeneği (AUTHZ-004).

**Eskimiş belgeler**
- [ ] `README.md:60` Vampire Village ve Watch Party'yi hâlâ "planlı" diyor.
- [ ] README kıyaslaması hâlâ "Revolt" diyor ve onu ses öncelikli değil
      sayıyor; Stoat'ta 2026'dan beri ses ve görüntü var.
- [ ] `docs/VAMPIRE_VILLAGE.md`'deki "tek yan kanal bus zamanlaması" ifadesi
      PLUG-001 düzelene kadar doğru değil.

### Kaynaklar

- Discord: support.discord.com (Krisp 360040843952, Stage 1500005513722,
  Etkinlikler 4409494125719, Thread 4403205878423, Anket 22163184112407, AutoMod
  4421269296535, Doğrulama seviyeleri 216679607, Yavaş mod 360016150952, Webhook
  228383668, Veri paketi 360004957991, Keşif 360030843331);
  docs.discord.com/developers (audit-log, application-commands, activities);
  discord.com/blog (E2EE, 8 Eylül 2026 sürüm notları); en.wikipedia.org/wiki/Discord
  (Türkiye engeli); techcrunch.com 2026/02/09 ve idtechwire.com (yaş doğrulaması).
  Not: discord.com bu makineden açılamadı (muhtemelen Türkiye engeli); Discord
  bilgileri resmî sayfaların arama özetlerinden.
- Stoat: en.wikipedia.org/wiki/Stoat_(software), github.com/stoatchat/self-hosted,
  stoat.chat sürüm notları, github.com/stoatchat/stoatchat CHANGELOG.
- Matrix/Element: element.io/blog (Element X/Call/Server Suite, AGPLv3'e geçiş,
  self-host E2EE ses/görüntü), element.io/en/server-suite/community,
  github.com/the-draupnir-project/draupnir.
- Mumble: mumble.info/blog (1.6.870-rc, 1.5.634).
- TeamSpeak 6: community.teamspeak.com (beta13, beta süreci),
  alternativeto.net/news/2026/8.
- Rocket.Chat: docs.rocket.chat/docs/our-plans, rocket.chat/blog (8.0, 8.5
  erişilebilirlik).
- Zulip: blog.zulip.com (12.0, 11.0, Zulip Foundation), zulip.com/help/self-hosted-billing.
- Mattermost: forum.mattermost.com (v11 ücretsiz sürüm değişiklikleri),
  docs.mattermost.com.
- Guilded: en.wikipedia.org/wiki/Guilded, alternativeto.net/news/2025/11.
- LiveKit: docs.livekit.io/transport/media/noise-cancellation,
  docs.livekit.io/transport/encryption.
- Yasal: OneSignal iOS web push belgesi, YouTube API koşulları
  (developers.google.com/youtube/terms), AB DSA SSS
  (digital-strategy.ec.europa.eu), KVKK aydınlatma rehberi (kvkk.gov.tr).
- coturn: github.com/coturn/coturn (`docker/coturn/debian/Dockerfile`: `USER
  nobody:nogroup`; `README.turnserver`: `--no-auth` varsayılan).

Uyarılar: Stoat'un tek yol haritası dosyası 2021 tarihli; "planlı" denenler o
zamandan beri çıkmış olabilir. Rakip hücrelerindeki "?" doğrulanamayan bilgiyi
gösterir.

## 11. Öncelikli yapılacaklar

**P0 — herkese açık kurulumdan önce**
1. INFRA-001: TURN ayar dosyasının sahipliğini ve iznini düzelt, coturn'ü
   fail-closed başlat, CI'a "kimliksiz Allocate → 401" testi ekle.
2. INFRA-002: render edilen ayarları `.dockerignore`'a ekle (tercihen izin listesi).
3. AUTH-001: masaüstü kodunu kimlik bilgisi sürümüne bağla.
4. AUTHZ-003: içerik düzenlemesini yalnızca yazara aç.
5. AUTHZ-001: kanalın son kapı rolünün silinmesini engelle.

**P1 — beta süresince**
6. AUTHZ-002: moderasyon durumunu üyelikten ayır; üye olmayanı banlamaya izin ver.
7. PLUG-001: oyun aksiyonlarını denetim günlüğüne yazma.
8. FILE-001: avatar/banner'ı ayrı bir rotadan sun, liste payload'ından çıkar.
9. HUB-001: kurulum başına benzersiz dizin kimliği ver ve proof sorgusunu düzelt
   (dizin kaydı ancak bundan sonra çalışır).
10. AUTH-002: sunucu tarafında oluşturulan sayfalar ve admin için iptal kontrolü.

**P2 — sonraki sürümler**
11. Düşük önemdekiler (AUTHZ-004/005/006, PLUG-002, HUB-002/003, FILE-002) ve
    §7'deki sertleştirmeler.

## 12. Düzeltme durumu (2026-10-03)

Dal: `fix/security-review-2026-10`. Her düzeltmenin testi var. Düzeltmelerin
tamamı salt-okunur bir inceleyiciye yeniden denetletildi; onun bulduğu bir
yan yol (FILE-001) ve yedi ek madde de kapatıldı.

| ID | Düzeltme | Doğrulama |
|---|---|---|
| INFRA-001 | TURN konteyneri root başlıyor ama yetkileri `SETUID, SETGID, DAC_READ_SEARCH, KILL, NET_BIND_SERVICE` ile sınırlı ve `no-new-privileges` açık. `proc-user=nobody` ile turnserver ayarı ve sertifikayı okuduktan sonra yetkisiz `nobody`'ye düşüyor. `cert-watcher.sh` ayar okunamazsa ya da REST auth yoksa başlamayı reddediyor. `no-tcp-relay` ve ek özel IP aralıkları eklendi. Kimliksiz Allocate yollayan `scripts/turn-auth-probe.mjs` yazıldı. | Gerçek coturn imajında açık relay **canlı olarak yeniden üretildi** (probe: OPEN RELAY). Düzeltmeden sonra 401 dönüyor, turnserver `nobody` kullanıcısıyla ve sıfır yetkiyle çalışıyor, root'a özel sertifikayla TLS (5349) açılıyor. Root olmayan kullanıcıya ait ayar dosyası okunuyor. `user:` satırı silinirse sunucu açılmayı reddediyor. CI artık `umask 077` ile render edip aynı kontrolleri yapıyor. |
| INFRA-002 | Render edilen ayarlar (`turnserver.conf`, `livekit.yaml`, `nginx/conf.d/*.conf`, `.install-staging*`) `.dockerignore`'a eklendi. CI, imajda render edilmiş TURN anahtarı arıyor. | Gerçek derlemede çalışma dizininde render edilmiş dosyalar varken imajda yoklar. |
| AUTH-001 | Masaüstü kodu, şifre hash'inin SHA-256 parmak iziyle saklanıyor; tamamlanırken eşleşmezse 401 dönüyor. Şifre değişikliği açık kodları siliyor. Diğer oturumlar kapatılamazsa yanıt 200 ve çevrilmiş bir uyarı. | Rota testleri: kod al → şifre değiştir → 401. |
| AUTH-002 | `getActiveSession` (okuma + iptal kontrolü, üretimde fail-closed) tüm sunucu sayfalarında, layout'ta, hub'da ve `isInstanceAdminAllowed`'da kullanılıyor. Bandwidth rotası çerezi istekten okuyor. İki `lf_guest` çerezi taşıyan istek 400 alıyor. | Birim testleri; gerçek stack e2e. |
| AUTHZ-001 | `deleteRole`, rol bir kanalın son kapısıysa 409 `role_gates_channels` döner. Roller sayfası kanalları adıyla gösteriyor. | Gerçek Postgres entegrasyon testi. |
| AUTHZ-002 | Yeni `server_member_sanctions` tablosu (migration 0040): timeout ve susturma ayrılınca da kalıyor, yeniden katılınca geri yükleniyor. Timeout alan davet oluşturamıyor. Üye olmayan kullanıcı banlanabiliyor. | Gerçek Postgres entegrasyon testi; dev veritabanı kopyasında geri doldurma doğrulandı. |
| AUTHZ-003 | Mesaj metnini yalnızca yazarı değiştirebiliyor (ayrıca `SEND_MESSAGES` gerekiyor). `MANAGE_MESSAGES` silme ve sabitleme yetkisini koruyor. | Rota testleri. |
| AUTHZ-004 | Davet ve otomatik katılım onay politikasına uyuyor (403 `approval_required`). Lobby "katılamazsın" mesajı gösteriyor. Ayar açıklamaları, henüz kuyruk olmadığı için yeni üyeleri engellediğini söylüyor. | Rota ve entegrasyon testleri. |
| AUTHZ-005 | Profil görünürlüğü üye listesinde, DM'lerde, engel listesinde, admin üye sayfasında ve resim rotasında uygulanıyor. | Projeksiyon testleri. |
| AUTHZ-006 | Susturmada ekran paylaşımı sesi de, timeout'ta tüm yayın kaynakları düşüyor. Boş kaynak listesi artık `canPublish:false` gönderiyor; LiveKit boş listeyi "her şey serbest" sayıyordu, ek bir açık buydu. Arayüz timeout'u doğru gösteriyor, düğmeler kapalı. | Token ve arayüz testleri. |
| PLUG-001 | Oyun aksiyonları (`member`/`player`) ve reddedilen aksiyonlar denetim günlüğüne yazılmıyor; host aksiyonları yazılıyor. `GamePluginActionPolicy.audit` seçeneği eklendi. | Gerçek VV ve Poll politika tablolarıyla rota testleri. |
| PLUG-002 | `authorizeChannelVisibility` üye olmayanı reddediyor. Ayrıca `constructor` gibi devralınan adlar artık politika sayılmıyor. | Rota testleri. |
| FILE-001 | Listelerde resim verisi yok; resimler `/api/users/<id>/avatar\|banner?v=` üzerinden, profil görünürlüğü uygulanarak sunuluyor. `getUserById` resim ve şifre hash'i sütunlarını hiç okumuyor; yazar adları tek bir dar sorguyla geliyor. Resim sürümü ayrı sütunlarda (migration 0041), kota hesabı SQL'de yapılıyor. | Gerçek Postgres betiği: kota doğru, profil düzenlemesi sürümü değiştirmiyor, yeni yükleme değiştiriyor. |
| FILE-002 | Doğrulama hataları genel bir mesaj dönüyor, noktasız hostname reddediliyor, dizin yazma rotaları yalnızca resmî hub'da var. | Rota testleri. |
| HUB-001 | Her kurulum rastgele bir UUID dizin kimliği alıyor (migration 0039). `.well-known` ve admin ayarı çalışıyor; `self-host`/`default` kimlikleri reddediliyor. | Rota testleri; migration gerçek Postgres'te. |
| HUB-002 | Var olan kayıt, saklı anahtar ve alan adıyla doğrulanıyor. Gösterilen alan değişince kayıt yeniden incelemeye düşüyor. | Gerçek Postgres entegrasyon testi. |
| HUB-003 | Bayat kayıtlar detay ve çıkış sayfasında gösterilmiyor; admin tüm kayıtları durumlarıyla görüyor. | Sayfa testleri. |

Toplam doğrulama: build, typecheck ve lint (0 hata) temiz. Tüm paket
testleri geçti (`apps/web` 1574). Veritabanı entegrasyon testleri gerçek
Postgres'te 136/136; migration'lar boş veritabanında ve dev verisinin
kopyasında uygulandı. Uçtan uca sonuçlar için PR açıklamasına bakın.

### Uçtan uca testlerin bulduğu iki ek hata (aynı gün düzeltildi)

- **Avatar/banner rotası her istekte 500 veriyordu.** Tek tabloluk sorguda
  Drizzle sütunları nitelemeden yazıyor, bu yüzden alt sorgulardaki
  `users.id` çıplak `"id"` olarak çıkıyordu: üyelik alt sorgusunda
  belirsiz bir sütundu, ayarlar alt sorgusunda ise sessizce
  `user_settings.id`'ye bağlanıyordu ("kimse" ayarı yok sayılırdı). Artık
  kullanıcı kimliği parametre olarak geçiyor. Gerçek Postgres testi eski
  sorguda kırılıyor, yenisinde geçiyor (`user-images.integration.test.ts`,
  CI'a da eklendi).
- **Susturulan üye sesini "kamera" ya da "ekran paylaşımı" etiketiyle
  yayınlayınca duyulabiliyordu** (LiveKit v1.13.7'de canlı doğrulandı:
  yaklaşık 82 KB ses geçti). LiveKit izin verirken yalnızca etikete
  bakıyor, izin ses mi görüntü mü olduğuna bakmıyor. Düzeltme iki katmanlı:
  - Uygulamanın dinleyicileri türü etiketiyle uyuşmayan izleri hiç
    çalmıyor: ses yalnızca mikrofon ve ekran sesi etiketiyle, görüntü
    yalnızca kamera ve ekran etiketiyle kabul ediliyor.
  - İmzalı bir LiveKit webhook'u (`/api/livekit/webhook`, nginx dışarıya
    kapalı) böyle bir iz yayınlayan katılımcıyı odadan atıyor ve denetim
    günlüğüne yazıyor.

  Var olan kurulumlarda webhook, ayarlar yeniden render edilince açılıyor
  (`bash install.sh`). İstemci katmanı güncellemeyle hemen geliyor.

### Takip turu (2026-10-03, `fix/security-followups`)

Yukarıda açık kalan maddeler ve §7'deki sertleştirmeler:

| Madde | Durum |
|---|---|
| Odadan atılan katılımcı yeniden bağlanabiliyordu | ✅ Atılan kullanıcı o sunucunun sesinden engelleniyor (10 → 30 → 120 dk) ve sunucunun diğer odalarındaki bağlantıları da kapatılıyor. Yeni token verilmiyor (`voice_blocked`). Eski token'la katılırsa `participant_joined` webhook'u onu hemen atıyor. LiveKit token ömrü 1 saatten 10 dakikaya indi; LiveKit bağlı katılımcının token'ını kendisi yeniliyor. |
| Eski oyun denetim satırları | ✅ Migration 0042, gizli bilgi sızdıran satırları siliyor: Vampire Village oyuncu aksiyonları ve anket oyları. Host aksiyonları, diğer eklentiler ve eski Watch Party'nin host kayıtları korunuyor; gerçek Postgres'te doğrulandı. |
| Onay kuyruğu yoktu | ✅ `server_join_requests` (0043). Davet ve otomatik katılım istek oluşturuyor; `KICK_MEMBERS` ya da `MANAGE_SERVER` yetkisi olan onaylıyor veya reddediyor. Ban her zaman öncelikli, yaptırımlar onayda uygulanıyor. Ret sonrası 7 gün bekleme, günde en fazla 5 istek. |
| Varsayılan erişim politikası tutarsızlığı | ✅ Kayıtlı politika yokken gösterilen ve uygulanan değer artık aynı (`public_self_register`). Gösterilen değerleri kaydetmek davranışı değiştirmiyor. |
| CI action sabitleme ve izinler | ✅ 57 `uses:` satırının hepsi SHA'ya sabitlendi. Varsayılan izin `contents: read`, yayın işlerine yalnızca gereken izinler veriliyor. İmzalama anahtarı `release` ortamına bağlandı (repo ayarlarında koruma kuralı sahibin işi). |
| Hesap başına giriş sınırı | ✅ E-posta başına 15 dakikada 10 hata; login ve masaüstü girişi ortak sayaç kullanıyor. Bilinmeyen e-posta da aynı şekilde sayıldığı için hesap tespiti yapılamıyor. Şifre değişikliğinde kullanıcı başına 15 dakikada 5 deneme. |
| Mutlak oturum ömrü | ✅ Çerezdeki `auth_time` alanından itibaren 30 gün (`LOBBYFORGE_SESSION_MAX_AGE_DAYS`). Eski çerezler ilk yenilemede saymaya başlıyor. |
| Diğer §7 maddeleri | ✅ Bot token döndürme ve Moderation Bot PATCH yetki kontrolleri. Gateway hata mesajı sızıntısı ve UUID doğrulaması. Hushle, zar ve Quiz'de kripto rastgelelik. Sahte bant genişliği raporlarına sınır. `fetchIpPinned` toplam süre sınırı; `::/96`, 6to4, Teredo ve yerel NAT64 engeli. Tar `prefix` alanı. `lfctl` açık anahtar zorunluluğu ve 0700/0600 izinler. Uygulamaların kanal/rol izin listelerinin uygulanması. Google adı doğrulaması. Proxy ayarı için Doctor uyarısı. |
| Marketplace eklenti yolu | ✅ `migrateState` artık bekleniyor; önceden state aksiyonlar arasında kayboluyordu. Kurulum ve worker aynı dizini kullanıyor. Yalnızca aktif olarak kaydedilen sürüm ve digest yükleniyor. İç içe paket reddediliyor. Bkz. `docs/EXTENDING.md`. |

Hâlâ açık:
- E-postayı bilen biri, yanlış şifre deneyerek o hesabın girişini 15
  dakikalık aralıklarla kilitleyebilir. Hesap başına sınırın bilinen
  ödünleşimi.
- Kural dışı sayılan dürüst bir istemci (beklenmedik bir tarayıcı hatası)
  10 dakika sesten engellenir.
- Plugin worker hâlâ tek UID'de çalışıyor (ADR-001); marketplace eklentileri
  düşmanca koda karşı tam izole değil.
- `style-src 'unsafe-inline'` CSP'de duruyor.
- Repo ayarlarında yapılacaklar: `release` ortamına `v*` koruma kuralı,
  `LF_RELEASE_SIGNING_KEY`'i ortama taşımak, Dependabot uyarılarını açmak.
  Ayrıca `infra/keys/release-ed25519-private.pem` dosyasını repo
  klasöründen taşımak.
