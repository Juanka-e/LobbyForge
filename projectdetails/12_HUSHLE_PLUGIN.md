# 12 — Hushle Plugin Tasarımı

## 1. Amaç

Hushle, Taboo benzeri bir kelime anlatma oyunudur. Marka olarak Taboo/Tabu kullanılmaz.

Sesli odada oynanır. Oyuncular konuşur, takım arkadaşları tahmin eder.

## 2. Temel özellikler

MVP:

- takım oluşturma
- oyuncu seçme
- kart gösterme
- ana kelime
- yasaklı kelimeler
- timer
- doğru/pas/ceza
- skor
- oyun sonu ekranı

İleri:

- custom card packs
- kategori seçimi
- zorluk
- community packs
- sezonluk kartlar
- istatistikler
- ranked/casual mod
- AI ile kart önerisi
- dil bazlı kart paketleri

## 3. Oyun akışı

1. Host Hushle başlatır.
2. Oyuncular katılır.
3. Takımlar oluşturulur.
4. Host kart paketi seçer.
5. İlk anlatıcı seçilir.
6. Timer başlar.
7. Anlatıcı kelimeyi anlatır.
8. Takım tahmin eder.
9. Host/karşı takım doğru/pas/ceza girer.
10. Sıra diğer takıma geçer.
11. Oyun sonunda skor gösterilir.

## 4. Roller

- Host
- Team A player
- Team B player
- Current explainer
- Spectator optional

## 5. State modeli

```ts
type HushleState = {
  phase: "lobby" | "team_setup" | "round" | "between_rounds" | "ended";
  teams: {
    id: string;
    name: string;
    playerIds: string[];
    score: number;
  }[];
  currentTeamId?: string;
  currentExplainerId?: string;
  currentCard?: HushleCard;
  timer: {
    startedAt?: string;
    durationSeconds: number;
    remainingSeconds: number;
  };
  settings: HushleSettings;
};
```

## 6. Card modeli

```ts
type HushleCard = {
  id: string;
  language: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  word: string;
  forbiddenWords: string[];
};
```

## 7. PostgreSQL verisi

Kalıcı:

- card packs
- cards
- game_sessions
- game_session_players
- game results
- score summaries

## 8. Redis verisi

Geçici:

- current timer
- active card cache
- current turn state
- live event pub/sub

## 9. UI

Hushle paneli:

- büyük kart
- timer
- takım skorları
- anlatıcı adı
- doğru butonu
- pas butonu
- ceza butonu
- sonraki kart
- host controls

Oyuncu UI:

- anlatıcı ana kelime + yasaklı kelimeleri görür
- tahmin edenler kartı görmez
- spectator sınırlı görünüm görür

## 10. Yetkiler

- start_hushle
- manage_hushle_session
- manage_card_packs
- view_hushle_results

## 11. Dil desteği

Kart paketleri dil bazlıdır:

```txt
hushle-tr-basic
hushle-en-basic
hushle-es-basic
```

Plugin locale dosyaları:

```txt
plugins/hushle/locales/tr.json
plugins/hushle/locales/en.json
```
