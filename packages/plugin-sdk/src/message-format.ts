/**
 * The message format every LobbyForge catalogue is written in — the app's
 * `apps/web/messages/**` and each plugin's `locales/*.json` alike, so a
 * translator learns it once.
 *
 * It is a small subset of ICU MessageFormat:
 *
 *   {name}                                      an argument
 *   {count, plural, one {# member} other {# members}}
 *   {count, plural, =0 {No one} one {# player} other {# players}}
 *   {kind, select, voice {Voice} other {Text}}
 *
 * Plurals are what make this necessary rather than nice. English and
 * Turkish have one or two forms; Russian and Polish have four, Arabic six.
 * With the categories in the message itself, each language writes the
 * forms it needs and nobody edits code to add one — the categories come
 * from `Intl.PluralRules`, which already knows every language's rules.
 * A translation may use `plural` even where English does not ("{count}
 * members" → a Russian plural over `count`): arguments must match,
 * not the shape of the sentence.
 *
 * Apostrophes are plain text. ICU treats `'` as an escape character,
 * which would mangle Turkish ("Hushle'ı", "token'ı") for a feature — a
 * literal brace — no message here needs.
 */

export type MessageParams = Record<string, string | number>;

type Case = { selector: string; body: string };
type Part =
  | { kind: 'text'; text: string }
  | { kind: 'arg'; name: string; raw: string }
  | { kind: 'plural' | 'select'; name: string; cases: Case[]; raw: string };

const ARG = /^\s*([A-Za-z0-9_]+)\s*$/;
const COMPLEX = /^\s*([A-Za-z0-9_]+)\s*,\s*(plural|select)\s*,([\s\S]*)$/;
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** Index of the `}` closing the `{` at `open`, or -1 when unbalanced. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function parseCases(source: string): Case[] | null {
  const cases: Case[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const lead = /^\s*/.exec(rest)![0].length;
    if (i + lead >= source.length) break;
    const selector = /^(=\d+|[A-Za-z0-9_]+)\s*\{/.exec(rest.slice(lead));
    if (!selector) return null;
    const open = i + lead + selector[0].length - 1;
    const close = closingBrace(source, open);
    if (close < 0) return null;
    cases.push({ selector: selector[1]!, body: source.slice(open + 1, close) });
    i = close + 1;
  }
  return cases;
}

/**
 * Split a message into text and arguments. Anything that does not parse
 * stays as literal text — a translator's typo must not blank the string
 * out at runtime; `pnpm i18n:status` is where it gets reported.
 */
function parse(template: string): Part[] {
  const parts: Part[] = [];
  let text = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) break;
    const close = closingBrace(template, open);
    if (close < 0) break;
    const inner = template.slice(open + 1, close);
    const raw = template.slice(open, close + 1);
    const simple = ARG.exec(inner);
    const complex = simple ? null : COMPLEX.exec(inner);
    const cases = complex ? parseCases(complex[3]!) : null;
    if (!simple && !cases) {
      text += template.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    text += template.slice(i, open);
    if (text) parts.push({ kind: 'text', text });
    text = '';
    parts.push(
      simple
        ? { kind: 'arg', name: simple[1]!, raw }
        : { kind: complex![2] as 'plural' | 'select', name: complex![1]!, cases: cases!, raw }
    );
    i = close + 1;
  }
  text += template.slice(i);
  if (text) parts.push({ kind: 'text', text });
  return parts;
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, value: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(value);
}

function formatNumber(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Fill a message in. `locale` must be the language the TEMPLATE is written
 * in — when a string fell back to English, English plural rules apply.
 *
 * An argument with no value is left visible (`{name}`): better a stray
 * placeholder than a word silently vanishing from a sentence.
 */
export function formatMessage(template: string, params: MessageParams | undefined, locale: string): string {
  if (!template.includes('{')) return template;
  let out = '';
  for (const part of parse(template)) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    const value = params?.[part.name];
    if (value === undefined) {
      out += part.raw;
      continue;
    }
    if (part.kind === 'arg') {
      out += String(value);
      continue;
    }
    let chosen: Case | undefined;
    if (part.kind === 'plural') {
      const n = Number(value);
      chosen =
        part.cases.find((c) => c.selector === `=${n}`) ??
        (Number.isFinite(n) ? part.cases.find((c) => c.selector === pluralCategory(locale, n)) : undefined) ??
        part.cases.find((c) => c.selector === 'other');
      if (chosen) {
        // `#` is the count itself, written the way the language writes numbers.
        const body = chosen.body.replace(/#/g, Number.isFinite(n) ? formatNumber(locale, n) : String(value));
        out += formatMessage(body, params, locale);
        continue;
      }
    } else {
      chosen = part.cases.find((c) => c.selector === String(value)) ?? part.cases.find((c) => c.selector === 'other');
      if (chosen) {
        out += formatMessage(chosen.body, params, locale);
        continue;
      }
    }
    out += part.raw;
  }
  return out;
}

/**
 * The argument names a message uses, sorted and de-duplicated —
 * including those inside plural/select cases. A translation must use
 * exactly the same set as English.
 */
export function messageArguments(template: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    for (const part of parse(text)) {
      if (part.kind === 'text') continue;
      names.add(part.name);
      if (part.kind !== 'arg') for (const c of part.cases) walk(c.body);
    }
  };
  walk(template);
  return [...names].sort();
}
