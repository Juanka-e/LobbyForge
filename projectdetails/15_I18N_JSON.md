# 15 — JSON Tabanlı Çeviri Sistemi

## 1. Genel karar

MVP’de çeviri paneli yapılmaz. Dil sistemi JSON dosyalarıyla çalışır.

Kullanıcılar yeni dil eklemek için JSON dosyası çevirir ve PR açar.

## 2. Yapı

Klasör kayıt defteridir — kodda dil listesi yoktur. Bir dil bir klasördür:

```txt
apps/web/messages/
  en/_locale.json      ad, yazı yönü, durum (complete | partial)
  en/lobby.json        alan başına bir dosya, düz "anahtar": "metin"
  en/admin.json
  tr/…
  de/…                 ← `pnpm i18n:add de` ile oluşur

plugins/hushle/locales/
  en.json
  tr.json
  de.json              ← "$status": "partial" taşıyabilir
```

Uygulanan sistemin ayrıntısı: `docs/TRANSLATING.md`.

## 3. Fallback

Sıra:

```txt
kullanıcının seçimi (lf_locale çerezi) → tarayıcı (Accept-Language, q değerleriyle)
  → örnek varsayılanı (LOBBYFORGE_DEFAULT_LOCALE) → en
```

Çevrilmemiş (boş) bir metin anahtar bazında İngilizceye düşer; bu yüzden
yarım bir çeviri de yayınlanabilir.

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

1. `pnpm i18n:add fr --name Français --english French` — uygulama ve tüm
   çevrilebilir eklentiler için boş şablonlar oluşur.
2. Boş değerler doldurulur (İngilizcesi `en/` klasöründe aynı sırada durur).
3. `pnpm i18n:status` ile ilerleme ve hatalar görülür.
4. Hepsi bitince `pnpm i18n:complete fr`.
5. PR açılır.

## 6. CI check

`pnpm test` ve `pnpm i18n:status` şunları denetler:

- `complete` işaretli dillerde eksik key var mı (`partial` dillerde eksik = ilerleme)
- İngilizcede olmayan (fazla/yetim) key var mı
- JSON geçerli mi, `_locale.json` doğru mu
- placeholder'lar korunmuş mu
- bir key İngilizcedeki ile aynı dosyada mı, iki dosyada birden tanımlı mı
- eklentilerin oluşturulmuş tablo dizini (`src/locales.generated.ts`) güncel mi

ICU/çoğul sözdizimi henüz kullanılmıyor; metinler yalnızca `{yer_tutucu}` içerir.

## 7. AI ile çeviri

AI kullanılabilir ama review gerekir.

Kurallar:

- `{username}` gibi placeholderlar bozulmaz
- marka isimleri çevrilmez
- teknik terimler tutarlı olur
- oyun terimleri context’e uygun çevrilir
- JSON syntax bozulmaz

## 8. Plugin çevirileri

Her plugin kendi `locales/<kod>.json` dosyalarını taşır ve plugin SDK'sının
`loadPluginLocale` / `tFor` fonksiyonlarıyla kullanır; ana uygulamanın
kataloğuna bağımlı değildir. Host, plugin'e hangi dili konuşacağını
`data-lf-locale` ile bildirir. Bir plugin o dili taşımıyorsa kendi
İngilizcesine düşer.

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
