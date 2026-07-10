# 00 — LobbyForge Master Dokümanı

## 1. Proje adı

Çalışma adı: **LobbyForge**

Kısa tanım:

> LobbyForge, açık kaynak ve self-host edilebilir bir sesli topluluk + oyun odaları platformudur.

Daha net ürün cümlesi:

> Kendi sesli topluluk sunucunu kur, Hushle/Taboo, Vampir Köylü, Quiz ve Watch Party gibi oda içi aktiviteleri çalıştır, istersen public server listesinde görün.

## 2. Ana konumlandırma

LobbyForge, “Discord klonu” olarak konumlandırılmamalıdır. Bu hem gereksiz beklenti oluşturur hem de rekabeti yanlış yerden başlatır.

Doğru konum:

- Self-host edilebilir
- Açık kaynak
- Sesli topluluk odaları
- Oyun ve aktivite pluginleri
- Public self-host server directory
- Kolay kurulum
- Sunucu kapasite/health advisor

Kısa İngilizce positioning:

> Self-hosted voice communities with built-in games.

## 3. Sabit teknik kararlar

Bu dokümanda kararlaştırılan stack:

- Web UI/API: Next.js
- Desktop: Electron
- Reverse proxy: Nginx
- Database: PostgreSQL
- Cache / queue / pub-sub / presence: Redis
- Media/SFU: LiveKit
- Deployment: Docker Compose
- Installer: shell script + ileride `lfctl`
- Translation: JSON language packs
- Main OS target for server: Ubuntu Linux
- Development environment for Windows user: WSL2 + Docker Desktop + VS Code Remote WSL

## 4. MVP hedefi

İlk gerçek ürün şuna indirgenmelidir:

> Web üzerinden çalışan, Docker Compose ile self-host edilebilen, LiveKit tabanlı sesli oda sistemi. İçinde Hushle plugin çalışıyor. Redis presence/cache için kullanılıyor, PostgreSQL kalıcı veriyi tutuyor, Nginx HTTPS/WSS reverse proxy olarak çalışıyor. Admin panelde temel health/capacity durumu görünüyor.

## 5. Ana farklılaştırıcılar

1. Oda içi oyun/activity sistemi
2. Self-host kolay kurulabilir yapı
3. Public self-hosted server directory
4. Doctor/capacity advisor
5. JSON dil paketleriyle kolay lokalizasyon
6. Electron ile global push-to-talk ve masaüstü deneyimi
7. Bot sistemi: müzik, moderasyon, oyun hostu, watch party

## 6. İlk official pluginler

Öncelik sırası:

1. Hushle — Taboo benzeri kelime oyunu
2. Vampir Köylü — gece/gündüz, gizli roller, oylama, private chat
3. Quiz
4. Watch Party
5. Music Room / Music Bot

## 7. Ana geliştirme sırası

1. Teknik spike: Next.js + PostgreSQL + Redis + LiveKit + Nginx
2. Core community MVP
3. Plugin SDK minimal
4. Hushle MVP
5. Installer ve self-host polish
6. LobbyForge Doctor
7. Vampir Köylü MVP
8. Electron desktop wrapper
9. Public directory / registry
10. Bot SDK + Watch Party + Music Bot prototipleri

## 8. Yapılmayacaklar

İlk sürümde yapılmayacaklar:

- Discord ile birebir özellik yarışı
- Binlerce eşzamanlı kullanıcı hedefi
- Full federasyon
- Mobil native app
- Rastgele üçüncü taraf plugin kodunu direkt çalıştırma
- Komple marketplace
- Recording/egress
- Tam E2EE mesajlaşma
- Telifli içerik yayınlama platformu

## 9. Açık kaynak yaklaşımı

Repo açık kaynak olmalıdır. Şu parçalar açık kaynak olur:

- Web app
- Electron wrapper
- Plugin SDK
- Bot SDK
- Official pluginler
- Installer
- Docker Compose
- Nginx configleri
- Registry software
- Documentation

Resmi registry instance ayrica yonetilir. Kod acik olur ama official public listede gorunme moderasyon ve guvenlik kurallarina baglidir.

## 10. Kimlik ve official LobbyForge karari

LobbyForge iki farkli kimlik alanini bilerek ayri tutar:

- **Official LobbyForge account:** lobbyforge.org, official registry, app/developer portal, official community hub ve Electron desktop baglanti senkronizasyonu icindir.
- **Instance local account:** her self-host instance'in kendi users/memberships/roles verisidir.

MVP'de federasyon yoktur. Bu yuzden bir kullanicinin official LobbyForge hesabinin olmasi, tum self-host instance'larda otomatik hesap sahibi oldugu anlamina gelmez. Varsayilan model:

```txt
lobbyforge.org account -> registry, official hub, desktop profile
voice.example.com account -> o instance'in local kullanicisi
oyunkulubu.com account -> baska bir local kullanici
```

Instance sahibi isterse "Sign in with LobbyForge" ozelligini acabilir. Bu durumda official hesap sadece identity provider gibi calisir; instance yine local user row, membership, role, ban ve audit kayitlarini kendi DB'sinde tutar.

## 11. App ekosistemi adlandirma karari

Kullaniciya her seyi "plugin" diye gostermek karisik olur. Urun dilinde ust kategori **Apps** olmalidir:

```txt
Apps
- Games: Hushle, Vampire Village, Quiz, Watch Party
- Bots: moderation, welcome, role, log, music
- Integrations: YouTube, Twitch, GitHub, Steam, OBS
```

Teknik dilde "plugin" ve "SDK" kullanilabilir. UI, registry ve marketing dilinde "App / Game / Bot / Integration" tercih edilir.

## 12. MVP urun siniri

Ilk surumun ana ekrani official LobbyForge hub + self-host/manual connect deneyimini gostermelidir. Kullanici:

1. Official LobbyForge app'e kaydolabilir.
2. Official hub/community icinde oyun odalarina girebilir.
3. Public registry'den self-host instance kesfedebilir.
4. Direkt domain/IP ile self-host instance'a baglanabilir.
5. Isterse Electron desktop indirip ayni web deneyimini desktop konforuyla kullanabilir.

Self-host instance'lar registry'ye bagimli olmadan calismaya devam eder.

## 13. Kesinlestirilen yeni urun kararlarinin kaynagi

Auth policy, registry ziyaretcisi davranisi, bot UI, oyun baslatma modeli, HUD/overlay, settings, activity status, tek tikla update ve web stack refactor listesi icin ana karar dosyasi:

```txt
projectdetails/31_PRODUCT_DECISIONS_AUTH_APPS_UPDATES.md
```
