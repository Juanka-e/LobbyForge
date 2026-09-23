# Translating LobbyForge

Adding a language is one command and some JSON. You never touch TypeScript,
and a half-finished translation can ship: every string you have not done yet
shows in English.

- [Add a language](#add-a-language)
- [Translate](#translate)
- [Check your progress](#check-your-progress)
- [Finish a language](#finish-a-language)
- [Guidelines](#guidelines)
- [For developers: adding strings](#for-developers-adding-strings)
- [How it works](#how-it-works)

## Add a language

```sh
pnpm i18n:add de --name Deutsch --english German
```

- `de` is the language code — a [BCP 47](https://www.w3.org/International/questions/qa-choosing-language-tags)
  tag such as `de`, `pt-BR` or `zh-Hans`. It becomes the folder name.
- `--name` is the language's name **in itself**. It is what people see in the
  language picker, so a German speaker finds "Deutsch", not "German".
- `--english` is its English name, shown alongside for everyone else.
- Add `--rtl` for a right-to-left language (Arabic, Hebrew, Persian, Urdu).

This creates, with every string blank and ready to fill in:

```
apps/web/messages/de/_locale.json     name, direction, status
apps/web/messages/de/<area>.json      one file per area of the app
plugins/<game>/locales/de.json        one per game that has translations
```

The language appears in **Settings → Appearance → Language** straight away,
marked *In progress*.

## Translate

Open a `de` file next to its English twin in `en/`. They have the same keys
in the same order:

```jsonc
// apps/web/messages/en/lobby.json
"lobby.voice.connected": "Voice Connected",
"lobby.apps.start": "Start {name}",

// apps/web/messages/de/lobby.json
"lobby.voice.connected": "",          ← fill this in
"lobby.apps.start": "",
```

- A **blank** string means "not translated yet" and shows the English text.
  Fill in as many or as few as you like — every one you do is live.
- Keep `{placeholders}` exactly as they are. You may move them within the
  sentence, since word order differs between languages, but not rename or
  drop them. `"Start {name}"` can become `"{name} starten"`; it cannot
  become `"{name} beginnen {game}"`.
- Only change the value, never the key on the left.

In development, refresh the page to see your edit — no restart needed.

## Check your progress

```sh
pnpm i18n:status
```

```
App — apps/web/messages

  en    English              ████████████████████ 100%  207/207  complete
  de    Deutsch (German)     ████████░░░░░░░░░░░░  41%   85/207  partial
  tr    Türkçe (Turkish)     ████████████████████ 100%  207/207  complete

Plugins — plugins/*/locales

  hushle    en 100%  ·  de 20% (partial)  ·  tr 100%
```

It also lists anything that would break the build, such as a placeholder
typed wrong or a key that does not exist in English.

## Finish a language

When everything is translated:

```sh
pnpm i18n:complete de
```

This refuses while anything is still blank. Once a language is marked
`complete`, the tests hold it to that: a developer who adds an English
string has to translate it too before their change can merge.

## Guidelines

- **Write for the person using the app**, not word for word. Say what a
  native speaker would say. `"Today at 11:34"` is `"Bugün 11:34"` in
  Turkish — no preposition — and the catalogues carry whole phrases for
  exactly this reason.
- **Use the words your community already uses.** If players of Discord,
  Steam or TeamSpeak in your language say "sunucu" rather than a literal
  translation, use that.
- **Keep sidebar labels short.** The sidebar is 240px wide.
- **Do not translate** brand and product names (LobbyForge, Hushle,
  LiveKit), the language names in the picker (each language is shown in its
  own name), or anything that is data rather than interface — channel names,
  usernames, card-pack names, the words inside a Hushle deck.
- **Machine translation** is fine as a starting point, but have a speaker
  review it, and check placeholders and tone.

Hushle's word decks are *content*, not interface: a German deck is a card
pack an admin creates under **Settings → Plugins & Word Packs**, separate
from translating Hushle's buttons.

### Right-to-left languages

`--rtl` sets `dir="rtl"` on the page, which is correct for the text. The
layout itself has not yet been audited for right-to-left: some components
use physical `left`/`right` positioning rather than logical `start`/`end`,
so parts of the chrome may not mirror correctly. The translation still
works; the layout pass is tracked separately.

## For developers: adding strings

Never put user-facing text in a component. Give it a key:

```tsx
// Client component
import { useT } from '@/lib/i18n/client';
const t = useT();
<button>{t('lobby.voice.disconnect')}</button>

// Server component
import { getTranslator } from '@/lib/i18n/server';
const t = await getTranslator();
```

Then add the key to the English catalogue for that area, and to every
language marked `complete` (today: Turkish):

```sh
# after editing apps/web/messages/en/lobby.json and tr/lobby.json
pnpm i18n:sync
```

`sync` gives every *partial* language a blank for your new string, so
translators see new work waiting for them, and regenerates each plugin's
`src/locales.generated.ts`. `pnpm test` fails if a complete language is
missing your string.

- **Keys** are `<area>.<thing>.<detail>` — `lobby.voice.connected`. They are
  global across files, so the prefix matches the file the key lives in.
- **A new area** is a new file: add `apps/web/messages/en/<area>.json`
  and the same file in each `complete` language. Nothing else to register.
- **Renaming a key** leaves the old one behind in every translation;
  `pnpm i18n:status` reports it, and `pnpm i18n:sync --prune` removes it.
- **Plugins** keep their own `locales/<code>.json` and translate with the
  plugin SDK's `tFor`. Keys start with the plugin id. A plugin with no
  `locales/` folder is English-only and declares `locales: ['en']`.
- **Dates and numbers:** `t.locale` is the language the translator speaks —
  pass it to `Intl` so a month name matches the sentence around it (see
  `lib/chat-time.ts`).

## How it works

- **The folder is the registry.** Languages are discovered from
  `apps/web/messages/<code>/_locale.json`; nothing in the code lists them,
  which is why adding one needs no code change.
- **The server picks the language**, in this order: the user's explicit
  choice (the `lf_locale` cookie, set from the language picker) → their
  browser's `Accept-Language`, honouring its quality values → the instance
  default (`LOBBYFORGE_DEFAULT_LOCALE`, e.g. `tr`) → English.
  "Match my browser" stores no cookie, so it keeps following the browser.
- **Only the active language reaches the browser**, already merged over
  English. Adding a language does not make the app bigger for anyone.
- **`<html lang>` is the page's language**, which CSS casing and screen
  readers depend on. Plugins read theirs from `data-lf-locale`, and their
  panel is tagged with the language the plugin actually speaks — English,
  if a game has not been translated into yours yet.
- **`complete` and `partial`** live in `_locale.json` (and as `"$status"`
  in a plugin's file). Only `complete` languages must have every string.

## Instance default language

A community whose members' browsers are set to English but who want the
community in their own language can set, for example:

```sh
LOBBYFORGE_DEFAULT_LOCALE=tr
```

This is a fallback, not an override: someone whose browser asks for a
language the instance has still gets it, and anyone can pick their own in
Settings.
