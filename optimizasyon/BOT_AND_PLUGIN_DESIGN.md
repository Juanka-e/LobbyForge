# LobbyForge — Bot ve Eklenti Tasarım Planı (BOT_AND_PLUGIN_DESIGN.md)

Bu doküman, LobbyForge platformunun bot, eklenti ve ses altyapısının sürdürülebilir, yüksek performanslı ve düşük sunucu kaynak tüketimi (resource-friendly) odaklı mimari tasarımını detaylandırmaktadır.

---

## 1. 🎵 Özgün ve Optimize Müzik Sistemi (Room-Level Audio vs Discord Bot)

Discord'un müzik botu yaklaşımı (Mee6, FredBoat vb.) her sunucu/oda için sisteme sahte bir kullanıcı (bot hesabı) bağlar. Bu bot ses kanalına girer, veritabanına yazılır, WebSocket oturumu açar ve sunucu üzerinde ağır bir ses kodlama (Opus transcoding) işlemi yapar. 100 odada müzik çalınması, sunucunun işlemcisini kilitleyebilir.

LobbyForge bu sorunu aşmak için **iki adet ultra-optimize yaklaşım** benimser:

### Yaklaşım A: Tarayıcı Tabanlı Senkronizasyon (Zero-Server-Load Model) - 🌟 Önerilen
Bu modelde sunucu **hiçbir ses dosyası işlemez, kodlamaz veya yayınlamaz**. Sunucu yükü tam anlamıyla **sıfırdır**.

*   **Çalışma Mantığı:** Müzik aktivitesi başlatıldığında, sunucu odadaki kullanıcılara sadece çalma listesi durumunu ve zaman damgasını (timestamp) dağıtır:
    ```json
    {
      "currentTrackId": "dQw4w9WgXcQ",
      "platform": "youtube",
      "startedAt": 1718912345,
      "isPlaying": true
    }
    ```
*   **İstemci (Client) Tarafı:** Her kullanıcının tarayıcısı, YouTube iframe API'si veya Spotify SDK'i üzerinden ilgili şarkıyı arka planda çalar ve sunucudan gelen zaman damgasına göre milisaniyelik hassasiyetle senkronize eder.
*   **Avantajları:** 
    *   Sunucuda ne CPU ne de bandwidth (bant genişliği) tüketilir.
    *   Kullanıcılar müzik sesini kendi tarayıcılarında bağımsız olarak ayarlayabilir.
    *   Telif hakkı (copyright) sorunları sunucu sahibini bağlamaz.

### Yaklaşım B: Oda Düzeyinde Sistem Kanalı (Room-Level Audio Track)
Eğer doğrudan sunucudan ses dosyası (örneğin bir MP3 veya internet radyosu) yayını yapılacaksa, bu bir sahte "kullanıcı bot" yerine **LiveKit Sistem Kanalı** olarak yapılmalıdır.

*   **Tasarım:** Ses odası ayarlarından yetkilendirilmiş bir kullanıcı müziği başlattığında, sunucu odaya yeni bir **System Audio Track** (Sistem Ses Kanalı) bağlar.
*   **Arayüz (UI) Konumlandırması:** 
    *   Müzik çaldığında ses kanalında sahte bir avatar/oyuncu listelenmez.
    *   Oda isminin hemen altında şık bir durum rozeti (badge) belirir:  
        `🎵 Now Playing: Loft Beats (03:14)`
    *   Kullanıcılar bu rozete tıklayarak müzik çalar arayüzünü (şarkı sırası, albüm kapağı, ses seviyesi) açabilirler.
*   **Optimizasyon:** LiveKit SFU (Selective Forwarding Unit) bu ses kanalını doğrudan C++ seviyesinde çoklayarak dağıtır. Node.js uygulamasına ek yük binmez.

---

## 2. 🤖 Botlar Oyuncu Gibi mi Görünmeli, Yoksa Sisteme mi Entegre Olmalı?

Eklentiler ve botlar görevlerine göre iki farklı arayüz ve mimari yapıda tasarlanmalıdır:

| Bot Tipi | Görünüm | Mimari Katman | Örnekler |
|---|---|---|---|
| **Aksiyonel & Medya Botları** | **Oyuncu/Avatar Gibi** | `@lobbyforge/bot-sdk` üzerinden odaya bağlanan sanal istemci | Müzik DJ'i, D&D Game Master, Yapay Zeka Ses Değiştirici |
| **Sistem & Moderasyon Botları** | **Gizli (Entegre Modül)** | Sunucu tarafında çalışan Middleware / System Service | Anti-Spam, Küfür Filtresi, Otomatik Rol Dağıtıcı, Log Analizci |

### Neden Bu Ayrım Önemli?
*   **Arayüz Temizliği:** Moderasyon yapan bir botun ses kanalında boş boş oturup avatar kaplaması anlamsızdır. Sadece odadaki aktif etkileşimli botlar avatar olarak görünmelidir.
*   **Yetki ve Denetim:** Oyuncu gibi görünen botlara kullanıcılar sağ tıklayarak susturma (mute), sesini kısma veya odadan atma (kick) gibi standart eylemleri uygulayabilmelidir.

---

## 3. 📉 Sistem Yükü ve Optimizasyon: Çoklu Eklenti Sunucuyu Yorar mı?

LobbyForge mimarisi, sunucu kaynak tüketimini minimumda tutmak için tasarlanmıştır. Eklentilerin sunucuya yük bindirme oranları şu şekildedir:

### A. İstemci Ağırlıklı (Client-Heavy) Eklentiler (Sunucu Yükü: ~%1)
*   **Örnekler:** Vampir Köylü, Quiz, Taboo, Hushle.
*   **Durum:** Bu oyunların tüm mantığı, grafikleri ve arayüzü tarayıcıda çalışır. 
*   **Yük Analizi:** Sunucu sadece oyuncular arasındaki WebSocket paketlerini (örneğin: *"Oyuncu A, Oyuncu B'ye oy verdi"*) iletir. Bu işlem sadece birkaç baytlık veri transferi gerektirir. 100 odada aynı anda Vampir Köylü oynanması sunucuyu yormaz.

### B. Sunucu Ağırlıklı (Server-Heavy) Eklentiler (Sunucu Yükü: Değişken)
*   **Örnekler:** Canlı ses filtreleme, video kodlama (Watch Party dosya dönüştürme).
*   **Optimizasyon Planı:**
    *   **Watch Party:** Video dosyalarını sunucu üzerinden stream etmek yerine, P2P (Peer-to-Peer) veya harici video linkleri (YouTube, Vimeo, S3) üzerinden çalıştırmak sunucu işlemci yükünü sıfıra indirir.
    *   **Telemetry Snapshots:** Eklentilerin durumları Redis üzerinde kısa ömürlü (ephemeral) olarak tutulur. PostgreSQL veritabanına sürekli yazma yapılmaz. Sadece oyun bittiğinde istatistikler kalıcı veritabanına yazılır.

---

## 4. 🛠️ Eklenti (Plugin) Sistemini Olgunlaştırma Planı

Spagetti kod yığınına dönüşmeyen, kararlı ve kolay genişletilebilir bir eklenti sistemi için şu adımları izleyeceğiz:

```
[Aşama 1: Stabilizasyon] ──► [Aşama 2: Güvenlik / Sandbox] ──► [Aşama 3: Geliştirici CLI]
```

### 1. Aşama: Durum Senkronizasyonunun Standartlaştırılması (Sync Engine)
Eklenti geliştiricilerinin en büyük zorluğu WebSocket kodları yazmaktır. SDK'e entegre edilecek bir **Shared State Engine** ile bu kolaylaştırılmalıdır:
```typescript
// Geliştirici sadece state'i günceller, SDK bunu odadaki herkese dağıtır.
const [gameState, setGameState] = useSharedState("vampire-village-session");
```

### 2. Aşama: Sandboxing (Güvenlik Duvarı)
Kötü niyetli üçüncü taraf eklentilerin ana uygulamanın çerezlerini veya JWT token'larını çalmasını önlemek için eklenti arayüzleri izole edilmelidir:
*   Bileşenler **`iframe`** içinde veya izole edilmiş gölge DOM (Shadow DOM) sınırlarında çalıştırılacaktır.
*   Eklentilerin dış dünyaya istek atması (fetch/xhr) isteğe bağlı olarak admin panelinden kısıtlanabilecektir.

### 3. Aşama: CLI ve Test Arayüzü (Playground)
Geliştiricilerin tüm projeyi ayağa kaldırmadan eklenti yazabilmesi için:
*   `lfctl create-plugin` aracı sunulacaktır.
*   Eklentiyi tarayıcıda tek başına çalıştırıp sanal kullanıcılar simüle edebilecek bir **Local Playground** geliştirilecektir.
