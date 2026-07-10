# 07 — Redis Stratejisi

## 1. Genel karar

Redis kalıcı veri tabanı değildir. LobbyForge’da Redis sadece realtime/geçici işler için kullanılır.

Kalıcı verinin sahibi PostgreSQL’dir.

## 2. Redis kullanım alanları

### Presence

```txt
presence:server:{serverId}
presence:channel:{channelId}
presence:voice:{channelId}
```

Örnek veri:

```json
{
  "userId": "user_123",
  "status": "online",
  "channelId": "ch_1",
  "lastSeen": 1760000000
}
```

### Voice state

```txt
voice:{roomId}:participants
```

Tutulabilir:

- userId
- muted
- deafened
- speaking
- connectionQuality
- joinedAt

### Rate limit

```txt
ratelimit:login:{ip}
ratelimit:message:{userId}
ratelimit:livekit-token:{userId}
```

### Pub/Sub

Kanallar:

```txt
server:{serverId}:events
channel:{channelId}:events
game:{sessionId}:events
registry:heartbeat
```

### Game runtime cache

Örnek:

```txt
game:{sessionId}:state
game:{sessionId}:timer
game:{sessionId}:votes
```

Ama oyun sonucu ve önemli eventler PostgreSQL’e yazılır.

### Distributed lock

Örnek:

```txt
lock:game:{sessionId}:phase-change
lock:screenshare:{roomId}
```

## 3. TTL stratejisi

Presence:

```txt
TTL: 30-90 saniye
```

Rate limit:

```txt
TTL: 1 dakika / 15 dakika / 1 saat
```

Game temporary state:

```txt
TTL: session aktif olduğu sürece + 1 saat
```

Invite throttle:

```txt
TTL: 10 dakika
```

## 4. Redis persistence

Redis için `appendonly yes` kullanılabilir ama yine de Redis kalıcı DB sayılmamalıdır.

Redis veri kaybederse:

- online listesi yeniden oluşur
- rate limit sıfırlanır
- aktif game state recovery PostgreSQL’den yapılabilir
- oyun session pause/recover mekanizması gerekir

## 5. Pluginlerde Redis

Pluginler Redis’e doğrudan rastgele erişmemelidir.

Plugin SDK üzerinden erişmeli:

```ts
pluginContext.cache.set(key, value, ttl)
pluginContext.cache.get(key)
pluginContext.pubsub.publish(channel, event)
pluginContext.lock.acquire(key, ttl)
```

Böylece plugin key namespace’i kontrol edilir.

## 6. Redis key naming

Format:

```txt
lf:{env}:{domain}:{resource}:{id}
```

Örnek:

```txt
lf:prod:presence:server:abc
lf:prod:game:session:xyz:timer
lf:prod:ratelimit:login:1.2.3.4
```

## 7. Redis güvenliği

- Redis portu dışarı açılmaz.
- Docker internal network içinde kalır.
- Redis password optional ama önerilir.
- Public internetten erişim kesinlikle olmaz.
- Redis command renaming MVP’de şart değil.
- Backup kritik kabul edilmez.

## 8. Redis olmadan çalışır mı?

Tek node development için bazı şeyler in-memory çalışabilir.

Ama production self-host için Redis Compose’a dahil olmalıdır.

Minimum production:

```txt
PostgreSQL + Redis + LiveKit + Nginx + Web
```
