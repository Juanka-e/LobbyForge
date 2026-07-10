# 15 — JSON Tabanlı Çeviri Sistemi

## 1. Genel karar

MVP’de çeviri paneli yapılmaz. Dil sistemi JSON dosyalarıyla çalışır.

Kullanıcılar yeni dil eklemek için JSON dosyası çevirir ve PR açar.

## 2. Yapı

```txt
packages/i18n/locales/
  en.json
  tr.json
  es.json

plugins/hushle/locales/
  en.json
  tr.json

plugins/vampire-village/locales/
  en.json
  tr.json
```

## 3. Fallback

Sıra:

```txt
user locale → server default locale → en
```

## 4. Örnek JSON

```json
{
  "voice.join": "Join voice",
  "voice.leave": "Leave voice",
  "activity.start": "Start activity",
  "vampire.phase.night": "Night falls...",
  "vampire.phase.day": "The village wakes up.",
  "hushle.card.pass": "Pass",
  "hushle.card.correct": "Correct"
}
```

## 5. Yeni dil ekleme

1. `en.json` kopyalanır.
2. `fr.json` yapılır.
3. Değerler çevrilir.
4. `pnpm i18n:check` çalıştırılır.
5. PR açılır.

## 6. CI check

Kontrol edilmeli:

- eksik key var mı
- fazla key var mı
- JSON valid mi
- placeholder korunmuş mu
- ICU syntax bozulmuş mu

## 7. AI ile çeviri

AI kullanılabilir ama review gerekir.

Kurallar:

- `{username}` gibi placeholderlar bozulmaz
- marka isimleri çevrilmez
- teknik terimler tutarlı olur
- oyun terimleri context’e uygun çevrilir
- JSON syntax bozulmaz

## 8. Plugin çevirileri

Her plugin kendi locale dosyalarını taşır.

Plugin yüklenince locale dosyaları ana i18n sistemine register edilir.

## 9. Panel gerekir mi?

MVP’de gerekmez.

İleride:

- Weblate
- Tolgee
- Crowdin
- admin override
- in-context translation

Ama ilk sürümde JSON + PR yeterlidir.

## 10. Dil önceliği

Başlangıç:

- English
- Turkish

Yakın hedef:

- Spanish
- Portuguese
- German
- French

İleride:

- Russian
- Polish
- Indonesian
- Arabic
