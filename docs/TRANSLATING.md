# Translating LobbyForge

Adding a language is one command and some JSON. You never touch TypeScript,
and a half-finished translation can ship: every string you have not done yet
shows in English.

- [Add a language](#add-a-language)
- [Translate](#translate)
- [Plurals](#plurals)
- [Check your progress](#check-your-progress)
- [Finish a language](#finish-a-language)
- [Guidelines](#guidelines)
- [For developers: adding strings](#for-developers-adding-strings)
- [How it works](#how-it-works)
- [Each person's language](#each-persons-language)
- [Instance default language](#instance-default-language)

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

The language appears straight away, marked *In progress*, everywhere a
language is chosen — with no code change:

- **Settings → Appearance → Language**, for every member;
- the first step of the **setup screen** (`/setup`), for a new instance;
- the **Default language** list in **Community Settings → Overview**.

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

## Plurals

Where a number is counted, English writes both forms in one string:

```json
"adminSettings.members.count": "{count, plural, one {# member} other {# members}}"
```

`#` is the number. Write the forms **your** language needs — the categories
are `zero`, `one`, `two`, `few`, `many` and `other`, plus `=0`, `=1`… for an
exact number, and `other` is always required:

```jsonc
// Russian — four forms
"{count, plural, one {# участник} few {# участника} many {# участников} other {# участника}}"
// Turkish — the noun stays singular after a number, so one form is enough
"{count} üye"
```

Which numbers fall into which category is built into every browser
([CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html));
you only write the words. You may use a plural even where English has a
plain `{count}`, and a plain `{count}` where English has a plural — what
must match is the argument name, not the shape.

`{kind, select, voice {…} other {…}}` picks by a word instead of a number,
where the code passes one.

An apostrophe is just an apostrophe (`"Hushle'ı başlat"`): unlike some ICU
tools, LobbyForge does not treat `'` as an escape character.

## Check your progress

```sh
pnpm i18n:status
```

```
App — apps/web/messages

  en    English              ████████████████████ 100%  1887/1887  complete
  de    Deutsch (German)     ████████░░░░░░░░░░░░  41%   774/1887  partial
  tr    Türkçe (Turkish)     ████████████████████ 100%  1887/1887  complete

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

## The desktop app

The desktop app speaks the same languages, with no extra step:

- **Its own screens** (the connect screen and the tray menu) use the
  `desktop.*` strings in `apps/web/messages/<code>/desktop.json`. Translate
  them like any other area. `pnpm i18n:sync` (which `i18n:add` runs) bundles
  every language into `apps/desktop/dist-shell/locales.js`; the app picks
  the system's language and falls back to English.
- **The Windows installer** offers every language Tauri's installer has a
  translation for: Arabic, Bulgarian, Chinese (Simplified and
  Traditional), Dutch, English, French, German, Italian, Japanese, Korean,
  Norwegian, Persian, Portuguese (and Brazilian), Russian, Spanish,
  Swedish, Turkish, Ukrainian and Vietnamese. `pnpm i18n:sync` writes the
  list into `apps/desktop/src-tauri/tauri.conf.json` from the language
  folders. For any other language, the app itself is translated and its
  installer is in English.
- `pnpm i18n:status` reports either file when it is out of date, and so do
  the tests, so a forgotten sync can't merge.

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
- **Counts:** pass the number, and write the English with a plural —
  `t('x.members', { count })` over `"{count, plural, one {# member} other
  {# members}}"`. Never pick between two keys with `count === 1 ? … : …`:
  that bakes English's two forms into the code, and a language with four
  cannot fix it from its JSON.
- **A link or element inside a sentence:** keep the whole sentence as one
  string with a marker, and place the element with `rich()` from
  `lib/i18n/rich.tsx` — each language then puts it where its word order
  wants it:

  ```tsx
  // "discovery.clearFiltersHint": "Try clearing the filters above, or {link}."
  rich(t('discovery.clearFiltersHint'), { link: <Link href="/connect">{t('discovery.connectByAddress')}</Link> })
  ```

- **Dates and numbers:** `t.locale` is the language the translator speaks —
  pass it to `Intl` so a month name matches the sentence around it (see
  `lib/chat-time.ts`).
- **The format is shared with plugins:** `tFor` in the plugin SDK formats
  the same syntax (`packages/plugin-sdk/src/message-format.ts`).

## How it works

- **The folder is the registry.** Languages are discovered from
  `apps/web/messages/<code>/_locale.json`; nothing in the code lists them,
  which is why adding one needs no code change.
- **The server picks the language**, in this order:
  1. the signed-in account's saved language (`users.locale`);
  2. this browser's choice (the `lf_locale` cookie);
  3. the browser's `Accept-Language`, honouring its quality values;
  4. the [instance default](#instance-default-language);
  5. English.

  Signed out, the order starts at 2. Each saved choice counts only while
  its language is installed: one whose folder was removed is skipped. A
  request does at most one extra lookup for this — a signed-in page reads
  one column of the account row; the instance default is cached.
- **Only the active language reaches the browser**, already merged over
  English. Adding a language does not make the app bigger for anyone.
- **`<html lang>` is the page's language**, which CSS casing and screen
  readers depend on. Plugins read theirs from `data-lf-locale`, and their
  panel is tagged with the language the plugin actually speaks — English,
  if a game has not been translated into yours yet.
- **`complete` and `partial`** live in `_locale.json` (and as `"$status"`
  in a plugin's file). Only `complete` languages must have every string.

## Each person's language

**Settings → Appearance → Language** saves the choice twice: on the
account (`users.locale`) and in the browser's `lf_locale` cookie. The
account copy is what makes it follow the person — the desktop app and a
second browser have cookie jars of their own — and it wins over the
cookie. The cookie keeps the choice in that browser after signing out.
Guests are accounts too, so they save it the same way.

**Match my browser** clears both: the account's language goes back to
NULL and the cookie is removed, so the browser's `Accept-Language`
decides again. NULL means "never chose"; an explicit English choice is
stored as `en` and honoured like any other. (Before migration 0048 the
column was `NOT NULL DEFAULT 'en'` and nothing wrote it, so the migration
cleared every `en` to NULL.)

Emails follow the same idea: the recipient's saved language, else the
language of the request that triggered the email, else the instance
default — and a password reset is written in the account owner's language,
not the language of whoever asked for it (docs/EMAIL.md §2.3).

## Instance default language

The default is what a visitor gets when neither their account, nor their
browser's cookie, nor their `Accept-Language` names a language the instance
offers — and the language of text with no single reader: the built-in
bots' default messages, an email with no recipient language, the language
hint a sandboxed plugin falls back to. It is decided in this order, each
step only when it names an installed language:

1. **the language saved by the owner** — picked on the first step of the
   setup screen, and changeable in **Community Settings → Overview →
   Default language**, which lists every installed language (in its own
   name, with its status) and says which step is in effect;
2. **`LOBBYFORGE_DEFAULT_LOCALE`** in the server environment, e.g.
   `LOBBYFORGE_DEFAULT_LOCALE=tr`;
3. English.

It is a fallback, not an override: someone whose browser asks for a
language the instance has still gets it, and anyone can pick their own in
Settings. The saved value lives in `instance_settings.default_locale`;
each server process caches it for 30 seconds, and the process that saves
it uses the new value at once. Changes are written to the audit log.
`lib/i18n/instance-default.ts` is the one place that resolves it.

**The setup screen.** Its first step, *Language*, lists every language
found under `apps/web/messages/`, starting on the one the browser asked
for. Picking one switches the wizard immediately — every later step is in
that language — and finishing setup saves it as the instance default and
as the owner account's language.

(`servers.default_locale` is set when a server is created but nothing
reads it: the language comes from the account, the browser and the
instance default above.)
