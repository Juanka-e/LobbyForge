# 10 — Public Self-Hosted Server Directory

## 1. Amaç

LobbyForge self-host instance’ları isterlerse official public listede görünebilir.

Bu özellik Discord discovery + TeamSpeak server list mantığının açık kaynak/self-host yorumudur.

## 2. Temel ayrım

### Instance UI

Her self-host kurulumun kendi UI’ı:

```txt
voice.example.com
```

### Official Registry UI

Merkezi public liste:

```txt
lobbyforge.org
```

Registry sadece keşif sağlar.

## 2.1 Registry'nin iki katalog tipi

Official registry iki farkli katalog tutar:

1. **Instance Directory:** public self-host instance listesi.
2. **App Catalog:** games, bots ve integrations listesi.

Bu iki katalog ayni UI'da gorunebilir ama veri ve guven modeli farklidir. Instance Directory bir sunucuya yonlendirir; App Catalog ise bir app'i bir instance'a kurma veya official hub'da deneme akisini baslatir.

```txt
lobbyforge.org/discover/servers -> public instances
lobbyforge.org/apps/games       -> Hushle, Vampire Village, Quiz
lobbyforge.org/apps/bots        -> moderation, welcome, music
lobbyforge.org/apps/integrations-> YouTube, Twitch, GitHub, Steam
```

## 3. Registry ne tutar?

Tutar:

- instance name
- domain
- description
- region
- languages
- tags
- features
- online user count
- public room count
- version
- doctor score
- last heartbeat
- verified/listed status

Tutmaz:

- mesajlar
- parolalar
- voice/video
- private room state

## 4. Public listeye ekleme akışı

1. Admin kendi VPS’ine LobbyForge kurar.
2. Admin panelde Public Directory açılır.
3. Instance key pair oluşturur.
4. Admin official registry’de hesap açar.
5. Domain doğrulaması yapılır.
6. Registry manifest endpoint’i okur.
7. Health check yapılır.
8. Signed heartbeat başlar.
9. Instance listelenir.

## 5. Instance manifest

Endpoint:

```txt
GET /.well-known/lobbyforge-instance.json
```

Örnek:

```json
{
  "instanceId": "inst_abc",
  "name": "Ankara Gaming Voice",
  "domain": "voice.ankaragaming.net",
  "version": "0.1.0",
  "region": "TR",
  "languages": ["tr"],
  "features": ["voice", "text", "hushle", "vampire-village"],
  "publicRooms": true,
  "requiresRegistration": false,
  "registryVisitorLoginMode": "instance-default",
  "nsfw": false
}
```

`registryVisitorLoginMode` public UX icin ipucu verir; registry bu ayari zorlamaz. Gercek auth kararini instance verir.

Degerler:

```txt
instance-default
lobbyforge-optional
lobbyforge-required-for-registry
lobbyforge-required-for-all
```

## 6. Heartbeat

Endpoint:

```txt
POST https://registry.lobbyforge.org/api/instances/heartbeat
```

Payload:

```json
{
  "instanceId": "inst_abc",
  "timestamp": 1760000000,
  "version": "0.1.0",
  "onlineUsers": 42,
  "publicRooms": 6,
  "features": ["voice", "text", "hushle"],
  "doctorScore": 82,
  "signature": "..."
}
```

Signature instance private key ile üretilir.

## 7. Domain verification

Yöntemler:

### DNS TXT

```txt
_lobbyforge.voice.example.com TXT "lf-verify=..."
```

### HTTP well-known

```txt
https://voice.example.com/.well-known/lobbyforge-verify.txt
```

MVP için HTTP well-known daha kolay olabilir.

## 8. Official registry UI

Liste kartında:

- logo/icon
- sunucu adı
- açıklama
- online kullanıcı
- dil
- bölge
- aktif pluginler
- verified badge
- doctor score
- NSFW uyarısı
- son heartbeat

## 9. Kullanıcı yönlendirme uyarısı

Kullanıcı tıkladığında:

```txt
Bu sunucu üçüncü taraf tarafından işletiliyor.
LobbyForge bu sunucunun içeriklerinden, hesaplarından veya moderasyonundan sorumlu değildir.
Devam ederseniz voice.example.com adresine yönlendirileceksiniz.
```

## 10. Manual connect

Public listede görünmek istemeyenler için:

```txt
Manual connect → domain veya IP gir
```

IP-only sunucular official listede varsayılan görünmez.

## 11. Abuse önlemleri

- report
- blocklist
- rate limit heartbeat
- minimum version
- phishing kontrolü
- NSFW flag zorunluluğu
- manual review opsiyonu
- verified badge
- owner contact

## 12. App Catalog metadata

Registry app catalog su bilgileri tutabilir:

```json
{
  "appId": "hushle",
  "name": "Hushle",
  "category": "game",
  "publisher": "LobbyForge",
  "trustLevel": "official",
  "version": "1.0.0",
  "summary": "Voice room word game",
  "minPlayers": 4,
  "maxPlayers": 12,
  "supportsSpectators": true,
  "requiresVoiceRoom": true,
  "externalAccountRequired": false,
  "permissions": [
    "voice.read",
    "game.session.create",
    "game.state.write",
    "chat.write"
  ],
  "compatibleAppVersion": ">=0.1.0"
}
```

Registry app catalog sunlari tutmamalidir:

- instance icindeki oyun state'i
- private app settings
- bot secrets
- OAuth access tokens
- oyuncu mesajlari veya voice metadata

## 13. Lobby'de game/app gorunumu

Official app ve desktop client icinde Games sekmesi kart tabanli olmali, ama kartlar pazarlama sayfasi gibi degil hizli karar vermeye yarayan operasyonel bilgi tasimalidir:

- app adi ve official/verified/unverified etiketi
- kategori: Game/Bot/Integration
- oyuncu araligi: `4-12 players`
- oda gereksinimi: `Voice room required`
- izin ozeti: `Reads participants, writes game state`
- guven etiketi: official, verified community, unverified self-host
- kullanilabilirlik: installed, available, incompatible, update available
- primary action: `Start`, `Install to server`, `Open in official hub`, `Connect account`

Game picker voice room icinde daha dar olmalidir:

```txt
Start Activity
- Hushle              4-12 players   Official
- Vampire Village    6-24 players   Official
- Quiz               2-50 players   Official
- Watch Party        2-100 sync-only Official
```

Bir voice room icinde MVP'de ayni anda sadece bir aktif activity session olabilir. Bu kural voice state, mute/deafen davranisi ve game event routing karmasasini azaltir.

## 14. Registry'den instance'a app kurma akisi

App catalog'daki "Install to server" butonu su akisi izler:

1. Kullanici official LobbyForge hesabiyla registry'ye girer.
2. Registry kullanicinin sahip oldugu veya yetkili oldugu instance'lari gosterir.
3. Kullanici bir instance secer.
4. Registry instance admin URL'ine signed install handoff ile yonlendirir.
5. Instance local auth ister veya mevcut session'i kullanir.
6. Instance izin ekranini gosterir.
7. Onaydan sonra app install kaydi instance DB'sine yazilir.

Son karari her zaman instance verir. Registry app'i zorla kuramaz.

## 15. Registry acik kaynak mi?

Evet, registry software açık kaynak olabilir.

Ama official registry instance senin yönettiğin resmi platformdur. Her açık kaynak kurulum official listeye otomatik girmez.
