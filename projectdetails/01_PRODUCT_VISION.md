# 01 — Ürün Vizyonu

## 1. Ürün nedir?

LobbyForge, kullanıcıların kendi VPS’lerine kurabileceği açık kaynak bir sesli topluluk ve oyun odaları platformudur.

Klasik sesli sohbet uygulamalarından farkı, sesli odanın üzerine doğrudan oyun ve aktivite katmanı kurmasıdır.

## 2. Ürün kime hitap eder?

Başlangıç hedefleri:

- Arkadaş grupları
- Küçük oyun toplulukları
- Üniversite kulüpleri
- Yayıncı toplulukları
- Discord alternatifi arayan küçük gruplar
- Self-host/open-source meraklıları
- Kendi VPS’inde özel sesli oda isteyenler
- Hushle/Taboo, Vampir Köylü, Quiz gibi oyunları sesli ortamda oynamak isteyenler

## 3. Neden var?

Mevcut çözümler genelde şu uçlarda kalıyor:

- Discord: güçlü ama kapalı, merkezi, self-host değil.
- TeamSpeak/Mumble: ses odaklı ama modern web/activity deneyimi sınırlı.
- Matrix/Mattermost: güçlü ama bazı kullanıcılar için ağır veya oyun odaklı değil.
- Jitsi: toplantı/video odaklı.
- Basit oyun siteleri: sesli topluluk altyapısı yok.

LobbyForge’un alanı:

> Küçük topluluklar için self-host edilebilir, oyun/activity destekli, modern sesli oda platformu.

## 4. Ana ürün vaadi

Türkçe:

> Kendi sesli oyun odanı kur. Arkadaşlarınla konuş, Hushle veya Vampir Köylü başlat, istersen sunucunu public listede göster.

İngilizce:

> Run your own voice server. Add party games. Go public if you want.

## 5. Başarı ölçütleri

## 4.1 Official hub ve self-host dengesi

LobbyForge sadece indirilen bir self-host paket degildir; ayni zamanda resmi bir giris kapisi sunar:

- official LobbyForge web app / hub
- public instance registry
- app catalog
- Electron desktop download
- developer/app owner portal

Bu resmi katman self-host vaadini bozmamalidir. Official hesap kullaniciya kolay kesif, desktop sync ve app/developer portal saglar; self-host instance'lar kendi auth, data, moderation ve app install kararlarini korur.

Teknik başarı:

- Tek VPS’e kurulabiliyor.
- Voice room stabil çalışıyor.
- Hushle plugin oynanabiliyor.
- Redis/PostgreSQL/Nginx/LiveKit Compose ile sorunsuz ayağa kalkıyor.
- Doctor temel sorunları tespit ediyor.
- Public registry’ye sunucu eklenebiliyor.

Ürün başarısı:

- İnsanlar kendi arkadaş gruplarıyla kullanıyor.
- Topluluklar Hushle/Vampir Köylü için sunucu açıyor.
- GitHub yıldızları ve contributor sayısı artıyor.
- Reddit/self-hosted topluluklarında ilgi görüyor.
- Kurulum süreci kullanıcıyı kaçırmıyor.

## 6. Marka tonu

- Açık
- Teknik ama anlaşılır
- Oyuncu dostu
- Güvenilir
- Self-host ruhuna uygun
- Abartısız
- “Discord’u bitiriyoruz” tarzı iddialardan uzak

## 7. İlk demo hikayesi

İlk güçlü demo videosu şöyle olmalı:

1. VPS’e tek komutla kurulum
2. Setup wizard
3. Bir voice room oluşturma
4. Arkadaşın guest olarak girmesi
5. Hushle activity başlatma
6. Sesli odada oyun oynama
7. Doctor’ın kapasite önerisini gösterme
8. Public directory’de sunucuyu listeleme
