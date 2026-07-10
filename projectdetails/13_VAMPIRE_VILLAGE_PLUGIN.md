# 13 — Vampir Köylü Plugin Tasarımı

## 1. Amaç

Vampir Köylü plugin'i sesli oda içinde dramatik, faz bazlı, gizli rollü sosyal çıkarım oyunu sunar. Bu plugin proje için güçlü demo değerine sahiptir.

## 2. Temel Deneyim

- Yetkili kişi oyunu başlatır.
- Oyuncular lobby'ye katılır (minimum 5, maksimum 12).
- Her oyuncu karakter oluşturur.
- Roller gizli dağıtılır.
- Gece/gündüz fazları döner.
- Gece UI kararır, gündüz aydınlanır.
- Vampirler gece özel chat/voice kullanır.
- Gündüz herkes tartışır ve oylama yapılır.
- Ölen kişi spectator olur.
- Oyun sonunda kazanan gösterilir, tüm roller açıklanır.

## 3. Oyun Modu Seçimi

Lobi ayarlarından iki mod seçilebilir:

| Mod | Açıklama | Timer |
|---|---|---|
| **Sadece Yazılı** | Tüm iletişim text chat üzerinden | Süreler tamamen özelleştirilebilir |
| **Ses + Yazılı** | Voice aktif + text chat destekli | Sabit süre önerileri, özelleştirilebilir |

Sadece yazılı modda oyuncular gece/gündüz sürelerini istedikleri gibi ayarlayabilir. Bu mod, sesli konuşamayan ortamlar veya metin tabanlı oynamayı tercih edenler için idealdir.

## 4. Yetki Modeli

```txt
start_vampire_game
manage_vampire_game
force_phase_change
assign_roles
kick_from_game
view_private_game_log
```

Rol: `Game Master / Oyun Başlatıcı`

## 5. Oyun Başlatma Akışı

1. Game Master voice/activity odasında "Start Activity" der.
2. Vampir Köylü seçilir.
3. Ayar modalı açılır:
   - Oyun modu (Sadece Yazılı / Ses + Yazılı)
   - Oyuncu sayısı (5–12)
   - Rol dağıtımı (Otomatik / Manuel)
   - Gece süresi (varsayılan: 30s)
   - Gündüz tartışma süresi (varsayılan: 90s)
   - Oylama süresi (varsayılan: 30s)
   - Son söz süresi (varsayılan: 15s)
   - Vampir özel chat/voice
   - Spectator ayarları
4. Oyuncular lobby'ye katılır.
5. Karakter oluşturulur (ad, ikon, renk).
6. Host oyunu başlatır.

## 6. Karakter Oluşturma

Oyuncu seçer:

- Karakter adı
- Avatar/ikon (preset listesinden veya özel)
- Renk (kart border rengi)
- Kısa bio (opsiyonel)

Bu bilgiler oyun session'ına özeldir.

---

## 7. Roller

### 🧛 Vampir Takımı

#### 🧛 Vampir (Vampire)
- **Takım:** Vampir
- **Gece aksiyonu:** Her gece bir kişiyi ısırarak öldürür.
- **Özel kural:** Kundakçı'yı ısıramaz (hedef geçersiz sayılır, gece boşa geçer).
- **Kazanma koşulu:** Vampirlerin sayısı hayatta kalan köylü takımından fazla veya eşit olursa, VEYA köydeki herkesi ısırarak kazanırlar.
- **İkon:** 🧛 Vampir dişleri

### 👨‍🌾 Köylü Takımı

#### 👨‍🌾 Köylü (Villager)
- **Takım:** Köylü
- **Gece aksiyonu:** Yok
- **Özel kural:** Gündüz tartışma ve oylamaya katılır. Temel rol.
- **İkon:** 👨‍🌾 Çiftçi

#### 🗳️ Başkan (Mayor)
- **Takım:** Köylü
- **Gece aksiyonu:** Yok
- **Özel kural:** Oyun boyunca istediği herhangi **2 turda 3 oy** kullanabilir (normalde 1 oy). Oylama sırasında önünde iki seçenek olur: "1 Oy Kullan" veya "3 Oy Kullan (Özel)". 3 oy kullandığı turda masum birinin (köylü rolü) asılmasında etkili olduysa, **sonraki 1 tur hiç oy kullanamaz** (ceza). Cezadan sonra normal 1 oy ile devam eder. 3 oy hakkı kullanılmadan devam eden turlarda kaybolmaz.
- **İkon:** 🗳️ Oy sandığı

#### 🔫 Avcı (Hunter)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece birini vurabilir. **2 mermisi** vardır.
- **Özel kural:** Masum birini (köylü takımı) vurur ve kişi gerçekten ölürse → **Avcı da ölür** (suçluluk cezası). Vampir veya tarafsızı vurursa cezasız kalır. Mermi bitince gece aksiyonu kalmaz.
- **İkon:** 🔫 Tabanca

#### 🔮 Büyücü (Seer)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece bir kişinin **gerçek rolünü** öğrenir.
- **Özel kural:** "Aşık", "Korunmuş" gibi durumları göremez — sadece temel rolü görür. Deli'nin gerçek rolünü (Köylü) görür, sahte rolünü değil.
- **İkon:** 🔮 Kristal küre

#### 🧪 Cadı (Witch)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece **sadece birini** kullanabilir: Zehir VEYA Şifa.
- **İksirleri:** 1 Zehir + 1 Şifa (oyun boyunca toplam, kullanıldıkça biter).
  - **Zehir:** Birini öldürür. Doktor koruması dahil korunamaz. Survivor kalkanı zehri engeller.
  - **Şifa:** Birini kurtarır (gece saldırısına karşı korur). Kundakçı yakmasını engelleyemez.
- **İkon:** 🧪 İksir şişesi

#### 🔍 Dedektif (Detective)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece **iki kişinin aynı takımda mı** olduğunu öğrenir.
- **Özel kural:** "Aynı takımdalar" veya "Farklı takımlardalar" sonucu döner. Rolleri göstermez. Tarafsızlar ayrı takım olarak sayılır.
- **İkon:** 🔍 Büyüteç

#### 🗣️ Geveze (Gossip)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece bir kişi seçer (gizlice).
- **Özel kural:** Geveze **öldüğünde veya asıldığında**, en son seçtiği kişinin rolü gündüz herkese açıklanır. Olay günlüğünde dramatik şekilde gösterilir.
- **İkon:** 🗣️ Konuşma balonu

#### 🤪 Deli (Fool)
- **Takım:** Köylü (gerçek rolü)
- **Gece aksiyonu:** Sahte rolünün gece aksiyonunu "uygular" ama hiçbir etkisi olmaz.
- **Özel kural:** Oyun başlangıcında rastgele bir köylü özel rolü (Büyücü, Dedektif, vb.) atanır. Kendi ekranında **sahte rol ve sahte bilgiler** görür. Örneğin sahte Büyücü olarak birisini "görmüş" gibi sahte sonuç alır. Diğer oyunculara gerçek etkisi yoktur. Büyücü Deli'yi sorguladığında "Köylü" sonucu alır.
- **Not:** Sahte bilgiler oyun başına tutarlı üretilir (Deli tutarsızlıktan anlayamasın).
- **İkon:** 🤪 Şapkalı yüz

#### 💉 Doktor (Doctor)
- **Takım:** Köylü
- **Gece aksiyonu:** Her gece birini korur.
- **Özel kural:** Aynı kişiye **üst üste iki gece** koruma uygulayamaz. Koruma; Vampir, Avcı, Kundakçı yakması ve Cadı zehrini engeller.
- **İkon:** 💉 Şırınga

### ⚪ Tarafsız Roller

#### 🔥 Kundakçı (Arsonist)
- **Takım:** Tarafsız
- **Gece aksiyonu:** Her gece iki eylemden birini yapar:
  1. **Benzin dök:** Birinin evine benzin döker (hazırlık, öldürme yok).
  2. **Yak:** Daha önce benzin döktüğü birisini yakar (öldürür).
- **Özel kurallar:**
  - Yakma eylemiyle öldürülen kişi, Cadı şifasından **KORUNAMAZ**.
  - Survivor kalkanı yakma eylemini **engeller**.
  - Vampirler Kundakçı'yı **ısıramaz** (hedef geçersiz).
  - Gündüz asılabilir.
- **Kazanma koşulu:** Hayatta kalan tek tarafsız olmak veya oyun sonunda hayatta kalmak.
- **İkon:** 🔥 Alev

#### 🛡️ Survivor (Hayatta Kalan)
- **Takım:** Tarafsız
- **Gece aksiyonu:** İstediği geceler "Kalkan Kullan" butonuna basar (aktif savunma).
- **Özel kurallar:**
  - **3 kalkanı** vardır. Kalkan aktifken gece saldırısından bir kalkan kaybederek hayatta kalır.
  - Cadı zehri dahil tüm saldırıları engeller (kalkan aktifken).
  - Kalkan kullanmadığı gecelerde normal şekilde öldürülebilir.
- **Kazanma koşulu:** Oyun sonunda **hayatta kalırsa KAZANIR** — vampir mi kazandı, köylü mü, fark etmez.
- **İkon:** 🛡️ Kalkan

#### 🃏 Jester (Soytarı)
- **Takım:** Tarafsız
- **Gece aksiyonu:** Yok
- **Özel kurallar:**
  - Gündüz **linçlenerek (asılarak) KAZANIR**.
  - Gece öldürülürse **kaybeder**.
  - Jester asıldığında, Jester'a oy veren oyunculardan rastgele biri **sonraki gece ölür** (intikam mekaniği — oyuncuları körü körüne oy vermekten caydırır).
- **İkon:** 🃏 Joker kartı

#### 💘 Eros (Çöpçatan)
- **Takım:** Tarafsız
- **Gece aksiyonu:** **Sadece ilk gece** — iki kişiyi aşık yapar.
- **Özel kurallar:**
  - Aşıklar birbirinin **gerçek rollerini** öğrenir (sadece aralarında).
  - Aşıklardan biri ölürse, diğeri **kederden ölür** (aynı gece/gündüz).
  - Aşk bağı kimseye açıklanmaz. Büyücü/Dedektif aşık durumunu göremez.
  - İlk gece aşıklardan biri ölürse, Eros otomatik **KAYBEDER** (ama oyunda kalır, köylü gibi davranır).
- **Kazanma koşulu:** Oyun sonunda aşıkların **İKİSİ DE** hayattaysa → Eros ve aşıklar KAZANIR.
- **İkon:** 💘 Ok yürek

---

## 8. Otomatik Rol Dağıtımı

### Vampir Sayısı (Oyuncu Sayısına Göre)

| Oyuncu | Vampir | Köylü Takımı | Tarafsız |
|---|---|---|---|
| 5 | 1 | 3 | 1 |
| 6 | 1 | 4 | 1 |
| 7 | 1 | 4 | 2 |
| 8 | 2 | 4 | 2 |
| 9 | 2 | 5 | 2 |
| 10 | 3 | 4 | 3 |
| 11 | 3 | 5 | 3 |
| 12 | 3 | 6 | 3 |

### Dağıtım Kuralları

- Her özel rolden (Avcı, Cadı, Doktor, Kundakçı vb.) **EN FAZLA 1** adet olur.
- Özel roller yetmediğinde kalan slotlara **temel Köylü** eklenir.
- Otomatik modda sistem en dengeli kombinasyonu seçer.
- Manuel modda host rolleri tek tek atayabilir (denge uyarısı gösterilir).

### Öncelikli Rol Ekleme Sırası (Otomatik Mod)

Oyuncu sayısı arttıkça roller bu sırayla eklenir:

1. **5 kişi:** Vampir, Köylü, Doktor, Büyücü, Survivor
2. **6 kişi:** + Avcı
3. **7 kişi:** + Jester
4. **8 kişi:** + 2. Vampir, Dedektif
5. **9 kişi:** + Cadı
6. **10 kişi:** + 3. Vampir, Kundakçı, Geveze
7. **11 kişi:** + Eros, Başkan
8. **12 kişi:** + Deli

---

## 9. Fazlar

```txt
lobby → role_reveal → night → dawn → day_discussion → voting → [execution → last_words] → [game_over | night]
```

### Faz Detayları

| Faz | Süre (Varsayılan) | Açıklama |
|---|---|---|
| `lobby` | Süresiz | Oyuncular katılır, ayarlar yapılır |
| `role_reveal` | 10s | Her oyuncu kendi rolünü ve açıklamasını görür |
| `night` | 30s | Gece aksiyonları yapılır, vampirler plan yapar |
| `dawn` | 5s | Gece sonuçları açıklanır (kim öldü, kim kurtarıldı) |
| `day_discussion` | 90s | Tartışma, suçlama, savunma |
| `voting` | 30s | Oylama (asılacak kişi seçimi) |
| `execution` | 5s | Asılma animasyonu ve sonucu |
| `last_words` | 15s | Asılan kişinin son sözleri (opsiyonel) |
| `game_over` | Süresiz | Kazanan, tüm roller, oyun özeti |

### Gece Bitiş Koşulu

Gece iki şekilde biter:
1. Tüm roller aksiyonlarını kullandığında **otomatik biter**.
2. Süre dolduğunda (aksiyon kullanmayan oyuncular pas geçmiş sayılır).

### İlk Gece Özel Kuralı

İlk gece sadece bilgi toplama + Eros aşk kurma aktif. Vampir ilk gece de ısırır.

---

## 10. 🌙 Gece Eylem Öncelik Sırası

Gece aksiyonları bu sırayla çözülür:

```
1. Bilgi Toplama      → Büyücü, Dedektif, Deli (sahte)
2. Hazırlık            → Kundakçı (benzin dökme)
3. Aşk Kurma           → Eros (sadece ilk gece)
4. Koruma               → Doktor, Cadı (şifa)
5. Öldürme (sırasıyla):
   5a. Kundakçı (yakma)
   5b. Avcı
   5c. Vampir
   5d. Cadı (zehir)
6. Otomatik Savunma    → Survivor (kalkan aktifse)
7. Sonuç Kontrolleri   → Avcı cezası, Geveze açıklama, Aşık ölüm zinciri
```

### Etkileşim Matrisi

| Saldırı ↓ / Savunma → | Doktor | Cadı Şifa | Survivor Kalkanı |
|---|---|---|---|
| Vampir ısırığı | ✅ Engeller | ✅ Engeller | ✅ Engeller |
| Avcı vurması | ✅ Engeller | ✅ Engeller | ✅ Engeller |
| Kundakçı yakması | ❌ Engellemez | ❌ Engellemez | ✅ Engeller |
| Cadı zehri | ❌ Engellemez | — | ✅ Engeller |

---

## 11. Oylama Mekaniği

### Oylama Akışı

1. Tartışma bitince oylama başlar.
2. Her oyuncu bir kişiye oy verir (veya "Kimseyi Asma" seçer).
3. Başkan özel oy hakkını kullanabilir (3 oy).
4. Oylama süresi dolunca sonuçlar açıklanır.

### Beraberlik Durumu

- İlk beraberlik → Berabere kalanlar arasında **30 saniyelik savunma** + **yeniden oylama** (sadece berabere kalanlar aday).
- İkinci beraberlik → **Kimse asılmaz**, gece fazına geçilir.

### Son Söz (Last Words)

Asılacak kişi belirlendikten sonra **15 saniye son söz** hakkı verilir. Bu sürede:
- Sadece o kişi konuşabilir/yazabilir.
- Rolünü açıklayabilir, suçlama yapabilir veya veda edebilir.
- Süre bitince asılma gerçekleşir.

---

## 12. Kazanma Koşulları

| Takım | Kazanma Koşulu |
|---|---|
| **Köylü** | Tüm vampirler öldürüldüğünde |
| **Vampir** | Vampir sayısı ≥ hayatta kalan köylü takımı sayısı |
| **Survivor** | Oyun sonunda hayattaysa (hangi takım kazanırsa kazansın) |
| **Jester** | Gündüz linçlenerek öldürüldüğünde |
| **Kundakçı** | Oyun sonunda hayattaysa |
| **Eros** | Oyun sonunda her iki aşık da hayattaysa |

### Aşık Özel Durumları

- Aşıklar farklı takımlardaysa (örn: bir Vampir + bir Köylü aşık), **ikisi de hayatta kaldığı sürece** kendi takımlarına bağlı kalır. Eros kazanması için ikisinin de hayatta olması yeterli — takım farketmez.
- Bir aşık ölürse diğeri de **anında ölür** (keder). Bu zincirleme olabilir.

---

## 13. UI / UX Tasarımı

### Renk Paleti

Koyu tonlar ağırlıklı, göz yormayan tasarım:

```css
/* Ana Tema */
--bg-primary: #0a0a0f;           /* Çok koyu lacivert-siyah */
--bg-secondary: #12121a;         /* Koyu panel */
--bg-card: #1a1a2e;              /* Oyuncu kartları */
--bg-card-dead: #0d0d0d;         /* Ölü oyuncu kartı */

/* Takım Renkleri */
--color-vampire: #dc2626;        /* Kırmızı */
--color-villager: #22c55e;       /* Yeşil */
--color-neutral: #a855f7;        /* Mor */

/* Faz Renkleri */
--color-night: #1e1b4b;          /* Gece koyu mavi */
--color-day: #1e293b;            /* Gündüz koyu gri-mavi */
--color-voting: #7c3aed;         /* Oylama mor */
--color-danger: #ef4444;         /* Ölüm/asılma kırmızı */

/* Metin */
--text-primary: #e2e8f0;         /* Açık gri */
--text-muted: #64748b;           /* Soluk gri */
--text-accent: #f59e0b;          /* Altın vurgu */
```

### Responsive Tasarım

| Ekran | Layout |
|---|---|
| Desktop (>1024px) | Sol: chat | Orta: oyun alanı + kartlar | Sağ: olay günlüğü |
| Tablet (768-1024px) | Üst: kartlar | Alt: chat + günlük (tab) |
| Mobil (<768px) | Tek kolon: kartlar → aksiyon → chat (swipe/tab) |

### Oyuncu Kartları

Modern, parlak kenarlı kartlar:

```
┌──────────────────┐
│  🧛 [İkon]       │  ← Rol ikonu (sadece kendi kartında görünür)
│                   │
│  ┌─────────────┐ │
│  │   Avatar    │ │  ← Karakter avatarı
│  └─────────────┘ │
│                   │
│  Erdal            │  ← Karakter adı
│  ♥♥♥              │  ← Hayatta göstergesi
│                   │
│  [Oy Ver]         │  ← Oylama butonu (gündüz)
└──────────────────┘
    ↑ border-color: oyuncunun seçtiği renk
```

**Ölü oyuncu kartı:**
```
┌──────────────────┐
│  💀              │  ← Kafatası ikonu
│  ┌─────────────┐ │
│  │  ▒▒▒▒▒▒▒▒▒ │ │  ← Soluk, siyah-beyaz avatar
│  └─────────────┘ │
│  ~~Erdal~~        │  ← Üstü çizili isim
│  🧛 Vampir       │  ← Rolü artık gösterilir
│  🩸 Isırıldı     │  ← Ölüm sebebi
└──────────────────┘
    ↑ border-color: koyu gri, opacity: 0.4
```

**Ölü kartı gündüz:** Altında "🩸 Isırıldı" / "🔫 Vuruldu" / "🔥 Yakıldı" / "🧪 Zehirlendi" / "⚖️ Asıldı" gibi ölüm sebebi yazar.

**Gece geçişinde:** Ölüm sebebi yazısı kaybolur — oyuncular sadece olay günlüğünden geçmişe bakabilir. Bu, oyuncuların odaklanmasını artırır ve oyunu basitleştirmez.

### Üst Sayaç Barı

Ekranın üstünde her zaman görünen durum barı:

```
┌─────────────────────────────────────────────────────────────┐
│  🌙 Gece 3  │  ⏱️ 00:18  │  🗳️ Oylama  │  👤 8/12 hayatta │
└─────────────────────────────────────────────────────────────┘
```

- Faz ikonu + ismi (Gece/Gündüz/Oylama/Tartışma)
- Geri sayım timer'ı
- Hangi olay gerçekleşiyor (kısa açıklama)
- Hayatta kalan oyuncu sayısı

**Vampir özel:** Sadece vampirler gece 30 saniyelik sayacı görebilir. Diğer oyuncular sadece "Gece..." yazar — süreyi göremezler. Bu, vampirlere plan yapma avantajı sağlar.

### Gece/Gündüz Geçiş Efekti

```
Gündüz → Gece:
  1. Ekran kenarlarından koyu mavi vignette yayılır (500ms ease-in)
  2. Arka plan rengi --color-day → --color-night (800ms transition)
  3. Yıldız parçacıkları (subtle particle effect) belirir
  4. Ay ikonu üst sayaçta solar (fade-in)

Gece → Gündüz (Dawn):
  1. Ekranın üstünden altına doğru ışık süzülür (gradient wipe, 600ms)
  2. Arka plan rengi --color-night → --color-day (800ms transition)
  3. Yıldızlar kaybolur
  4. Güneş ikonu üst sayaçta belirir
```

### Rol Kullanım Efekti

Bir oyuncu rolünü kullandığında, hedef oyuncunun kartında kısa efekt gösterilir:

| Rol | Efekt (hedefin kartında) | Süre |
|---|---|---|
| Vampir ısırığı | 🩸 Kırmızı pulse glow | 1s |
| Doktor koruması | 💚 Yeşil kalkan shimmer | 1s |
| Büyücü bakışı | 🔮 Mor parıltı | 0.8s |
| Avcı vurması | 💥 Turuncu flash | 0.5s |
| Cadı zehri | ☠️ Yeşil-mor duman | 1.2s |
| Cadı şifası | ✨ Altın sparkle | 1s |
| Kundakçı benzin | 🛢️ Turuncu damla | 0.5s |
| Kundakçı yakma | 🔥 Alev animasyonu | 1.5s |

**Not:** Bu efektler sadece **aksiyonu yapan kişinin ekranında** görünür (gizlilik). Dawn fazında sonuçlar herkese açıklanır.

---

## 14. Olay Günlüğü (Game Log)

### Amaç

Oyuncular kartlardaki ölüm bilgisini gece geçişinde kaybeder — **sadece olay günlüğünden geçmişe bakabilir**. Bu tasarım:
- Oyuncuların aktif olarak bilgi takip etmesini sağlar
- Oyunu basitleştirmez, odaklanmayı artırır
- Önemli bilgilerin kaçırılma riskini stratejik hale getirir

### Günlük İçeriği

```
📜 Olay Günlüğü
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🌅 Gün 1 — Gündüz
  💬 Tartışma başladı (90s)
  🗳️ Oylama: Ali (4), Zeynep (2), Pas (2)
  ⚖️ Ali asıldı → Rolü: 👨‍🌾 Köylü
  🗣️ Ali'nin son sözleri: "Zeynep'e dikkat edin..."

🌙 Gece 1
  🩸 Mehmet öldürüldü (vampir tarafından ısırıldı)
  💉 Ayşe korundu (Doktor tarafından)

🌅 Gün 2 — Gündüz
  🗣️ Geveze'nin mirası: Zeynep → 🔥 Kundakçı
  💬 Tartışma başladı (90s)
  ...
```

### Görünürlük Kuralları

| Bilgi | Canlı Oyuncular | Ölü/Spectator | Host |
|---|---|---|---|
| Kim öldü (gündüz) | ✅ | ✅ | ✅ |
| Kim öldü (gece) | ✅ | ✅ | ✅ |
| Ölüm sebebi | ✅ (genel) | ✅ (detaylı) | ✅ (tam) |
| Asılan kişinin rolü | ✅ | ✅ | ✅ |
| Gece ölenin rolü | ❌ | ✅ | ✅ |
| Oylama detayları | ✅ | ✅ | ✅ |
| Gece aksiyonları | ❌ | ❌ | ✅ |

---

## 15. Ses Tasarımı

### Ambient Ses (Opsiyonel, Ayarlanabilir)

| Faz | Ambient | Notlar |
|---|---|---|
| Gece | Cırcır böceği, rüzgar, baykuş | Düşük volüm, loop |
| Gündüz | Kuş cıvıltısı, hafif rüzgar | Düşük volüm, loop |
| Oylama | Gerilim müziği (düşük) | Drum tension |
| Game Over | Kazanan takıma göre (zafer/yenilgi) | Kısa jingle |

### Etki Sesleri

| Olay | Ses | Süre |
|---|---|---|
| Rol açıklanması | Dramatik reveal | 2s |
| Ölüm (gece) | Boğuk çığlık + rüzgar | 1.5s |
| Asılma (gündüz) | Davul + çan | 2s |
| Oylama tamamlandı | Gong | 1s |
| Timer son 5 saniye | Tik-tak (hızlanan) | 5s |
| Gece→Gündüz geçişi | Horoz ötüşü | 1.5s |
| Jester kazandı | Kahkaha | 2s |
| Aşık ölüm zinciri | Kırılan kalp | 1s |

---

## 16. Chat Kanalları

### Game Chat
Yaşayan herkes görür ve yazar. Gece sadece okunabilir (ses+yazılı modda).

### Vampire Chat
Sadece vampirler görür. Ses+yazılı modda: gece voice + text aktif. Sadece yazılı modda: her zaman text aktif.

### Dead Chat
Ölüler ve spectator'lar görür. Canlı oyuncular göremez.

### Host Log
Sadece host/admin görür. Tüm gece aksiyonları, tüm roller, tüm oylar detaylı.

---

## 17. Vampir Özel Konuşma (Ses Modunda)

### Karar: Track Subscription Control

Tüm oyuncular aynı LiveKit room'unda kalır. Gece fazında sunucu tarafından izin değişikliği yapılır:

```ts
// Server-side: Gece fazı başlıyor
async function startNightPhase(room: string, players: Player[]) {
  const vampires = players.filter(p => p.role === 'vampire');
  const others = players.filter(p => p.role !== 'vampire');

  // Vampir olmayanları sustur
  for (const player of others) {
    await livekitService.updateParticipant(room, player.id, {
      canPublish: false,
      canSubscribe: false,
    });
  }

  // Vampirler konuşabilir
  for (const vampire of vampires) {
    await livekitService.updateParticipant(room, vampire.id, {
      canPublish: true,
      canSubscribe: true,
    });
  }
}

// Server-side: Gündüz fazı başlıyor
async function startDayPhase(room: string, players: Player[]) {
  for (const player of players) {
    if (player.isAlive) {
      await livekitService.updateParticipant(room, player.id, {
        canPublish: true,
        canSubscribe: true,
      });
    }
  }
}
```

**Neden ayrı room değil:** Room geçişi 1-3 saniye gecikme yaratır, bağlantı sesleri duyulur.

**Neden client-side mute değil:** Oyuncular kendini açabilir, hile yapabilir. Sunucu kontrolü şart.

**Ölü oyuncular:** `canPublish: false, canSubscribe: true` — dinleyebilir ama konuşamaz. Spectator toggle ile tamamen kapatılabilir.

---

## 18. State Modeli

```ts
type VampireGameState = {
  phase: GamePhase;
  dayNumber: number;
  gameMode: 'text_only' | 'voice_and_text';
  players: Record<string, VampirePlayerState>;
  roles: Record<string, SecretRole>;       // server-only, never sent to clients
  nightActions: NightAction[];
  votes: Record<string, string>;
  mayorVotesUsed: number;                  // 0, 1, or 2
  mayorPenaltyTurns: number;               // remaining penalty turns
  loveCouple: [string, string] | null;     // Eros aşıkları
  erosFirstNightDone: boolean;
  timers: TimerState;
  gameLog: GameLogEntry[];
  winner?: 'villagers' | 'vampires' | null;
  individualWinners: string[];             // Jester, Survivor, Eros, Kundakçı
};

type VampirePlayerState = {
  userId: string;
  characterName: string;
  avatarIcon: string;
  color: string;
  isAlive: boolean;
  deathCause?: 'bitten' | 'shot' | 'burned' | 'poisoned' | 'hanged' | 'heartbreak';
  deathDay?: number;
  isLover: boolean;                        // Eros aşığı mı
  role: string;                            // client'a sadece kendi rolü gönderilir
  // Rol-spesifik
  hunterBullets?: number;                  // Avcı: kalan mermi
  witchHealUsed?: boolean;                 // Cadı: şifa kullanıldı mı
  witchPoisonUsed?: boolean;               // Cadı: zehir kullanıldı mı
  survivorShields?: number;                // Survivor: kalan kalkan
  arsonistTargets?: string[];              // Kundakçı: benzin dökülen hedefler
  mayorSpecialVotesLeft?: number;          // Başkan: kalan 3-oy hakkı
  gossipTarget?: string;                   // Geveze: son seçilen kişi
  foolFakeRole?: string;                   // Deli: sahte rol
};

type GameLogEntry = {
  dayNumber: number;
  phase: 'night' | 'day' | 'voting' | 'execution';
  event: string;
  visibility: 'all' | 'dead' | 'host';
  timestamp: number;
};
```

---

## 19. Oyun Sonu Ekranı

Oyun bittiğinde detaylı özet ekranı:

```
╔══════════════════════════════════════════════╗
║          🏆 KÖYLÜLER KAZANDI!               ║
╠══════════════════════════════════════════════╣
║                                              ║
║  Oyuncu         Rol          Durum           ║
║  ─────────────────────────────────────────── ║
║  Erdal          🧛 Vampir    💀 Gün 3 Asıldı║
║  Ayşe           💉 Doktor    ♥ Hayatta      ║
║  Mehmet          👨‍🌾 Köylü    💀 Gece 1 Isırıldı ║
║  Zeynep          🔮 Büyücü    ♥ Hayatta      ║
║  Ali             🛡️ Survivor  ♥ Hayatta 🏆  ║
║                                              ║
║  📊 İstatistikler                            ║
║  Toplam tur: 5                               ║
║  Toplam ölüm: 4                              ║
║  En çok oy alan: Erdal (7 oy)                ║
║  MVP: Ayşe (3 başarılı koruma)               ║
║                                              ║
║  [📜 Tam Günlük]  [🔄 Tekrar Oyna]          ║
╚══════════════════════════════════════════════╝
```

"Tam Günlük" butonu: Tüm gece aksiyonları, tüm roller, tüm oylar, tüm korumaların tam kronolojik listesi. Oyun bittikten sonra herkes her şeyi görebilir.

---

## 20. Host Paneli

Host görebilir:
- Tüm oyuncular ve rolleri
- Mevcut faz ve timer
- Oylar (anlık)
- Gece aksiyonları (anlık)
- Tam oyun günlüğü

Host yapabilir:
- Faz değiştir (zorla)
- Süre ekle/azalt
- Oyuncu öldür/geri al
- Oylama başlat
- Oyunu bitir / iptal et
- Acil pause (tüm timerlar durur)

---

## 21. Oyuncu Çıkarsa

Oyun sırasında çıkarsa:
- Reconnect timer başlar (60 saniye varsayılan)
- Dönmezse host'a seçenek:
  - Oyunu pause et
  - Oyuncuyu "öldü" say
  - Oyunu iptal et
- Bot ile devam seçeneği MVP'de yok (gelecek)

---

## 22. Spectator

Geç katılanlar veya ölenler spectator olur.

Ayarlar (host belirler):
- Rolleri görebilir/göremez
- Dead chat açık/kapalı
- Voice dinleyebilir/dinleyemez
- Public chat yazabilir/yazamaz

---

## 23. MVP Kapsamı

### MVP'de Olacak

- Lobby + karakter oluşturma
- Otomatik rol dağıtımı (5-8 oyuncu)
- MVP roller: Vampir, Köylü, Doktor, Büyücü, Avcı, Survivor, Jester (7 rol)
- Gece/gündüz fazları + timer
- Vampir text chat (gece)
- Public game chat
- Oylama + asılma
- Olay günlüğü
- Üst sayaç barı
- Oyuncu kartları (canlı + ölü)
- Gece/gündüz geçiş efekti
- Game over ekranı (basit)
- Spectator (ölüler)
- Responsive layout
- Koyu tema
- Sadece yazılı mod

### Phase 2'de Eklenecek

- Ses + Yazılı mod (LiveKit track subscription)
- Cadı, Dedektif, Geveze, Kundakçı rolleri
- 9-12 oyuncu desteği
- Başkan, Eros, Deli rolleri
- Son söz mekaniği
- Jester intikam mekaniği
- Ambient sesler
- Rol kullanım efektleri
- Detaylı oyun sonu ekranı (istatistikler, MVP)
- Manuel rol dağıtımı
- Host paneli (gelişmiş)

### Gelecek

- AI narrator (sesli anlatıcı)
- Senaryo paketleri (farklı tema: uzay, ortaçağ, vb.)
- Özel rol paketleri (community)
- Replay/kayıt
- Ranked/casual mod
- Turnuva desteği
- Yeni roller (Vampir Lordu, Şerif, Koruyucu, vb.)
