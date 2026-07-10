# 08 — LiveKit Medya Katmanı

## 1. Genel karar

LobbyForge medya/SFU katmanı olarak LiveKit kullanır.

LiveKit şu özellikler için kullanılır:

- Sesli oda
- Video
- Screen share
- Audio level
- Active speaker
- Room/participant/track eventleri
- Data channel
- Webhooks

## 2. LiveKit room mapping

Her voice channel bir LiveKit room’a karşılık gelir.

Önerilen room name:

```txt
instance:{instanceId}:server:{serverId}:channel:{channelId}
```

Örnek:

```txt
instance:main:server:abc:channel:voice123
```

## 3. Token üretimi

Client direkt LiveKit secret bilmez.

Akış:

1. Client voice kanala girmek ister.
2. Next.js API’ye token ister.
3. API kullanıcının yetkisini kontrol eder.
4. LiveKit API key/secret ile JWT üretir.
5. Client `wss://rtc.example.com` adresine bağlanır.

Token grants:

- join room
- publish audio
- subscribe
- publish video optional
- publish screen optional
- data channel optional

## 4. Medya politikası

MVP default:

- audio-first
- video opt-in
- screen share max 1
- active speaker layout
- grid video sınırlı
- max camera users per room Doctor önerisine göre

## 5. Screen share

Kurallar:

- Aynı odada varsayılan max 1 aktif screen share.
- Host/admin override edebilir.
- Screen share FPS ve bitrate sınırı olur.
- Weak server profile’da screen share düşük kaliteye çekilir.

## 6. Video layout

Varsayılan:

```txt
Active speaker büyük
Diğerleri thumbnail
```

Grid layout:

- küçük odalarda
- max 4/6/9 video
- server profile’a bağlı

## 7. Data channel kullanımı

Kullanım alanları:

- plugin realtime eventleri
- Hushle timer eventleri
- Vampir Köylü faz değişimi
- watch party play/pause/seek
- connection quality eventleri
- non-critical low-latency UI sync

Kritik state sadece data channel’a güvenmemelidir. Backend authoritative olmalıdır.

## 8. Webhooks

LiveKit webhooks ile backend’e şu eventler gelebilir:

- room_started
- room_finished
- participant_joined
- participant_left
- track_published
- track_unpublished

Kullanım:

- presence düzeltme
- audit log
- screen share state
- Doctor telemetry
- oyun session state

## 9. TURN

Gerçek dünyada bazı kullanıcıların UDP bağlantısı sorunlu olabilir. TURN/coturn opsiyonel ama önerilen advanced kurulum olmalıdır.

İlk sürüm:

- UDP portları açık kurulum
- TURN disabled by default olabilir

İleri:

- Installer TURN seçeneği sunar
- `turn.example.com`
- coturn container

## 10. Media provider abstraction

LiveKit’e aşırı kilitlenmemek için interface:

```ts
interface MediaProvider {
  createToken(input: CreateTokenInput): Promise<string>;
  getRoom(roomName: string): Promise<RoomInfo>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  muteParticipant(roomName: string, identity: string): Promise<void>;
}
```

İlk implementation:

```txt
LiveKitMediaProvider
```

İleride:

```txt
MediasoupMediaProvider
JanusMediaProvider
```

## 11. Kapasite mantığı

Ana maliyet outgoing bandwidth’tir.

Audio-only daha ucuzdur.

Video grid pahalıdır.

Screen share tek yayıncı + çok izleyici modelinde nispeten daha kontrollüdür.

Doctor buna göre öneri üretir:

- max voice users
- max camera users
- max screen share viewers
- recommended bitrate
- recommended layout
