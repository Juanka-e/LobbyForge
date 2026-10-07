/**
 * The character an avatar shows when there is no picture: the first
 * user-perceived character of a name.
 *
 * `name.charAt(0)` took one UTF-16 code unit, which is half of an emoji's
 * surrogate pair. Avatars showed "�", and because the server serialises a
 * lone surrogate as U+FFFD while the browser keeps it, the server HTML and
 * the client render disagreed: React threw hydration error #418 on every
 * lobby load that had such a name in it.
 *
 * This returns a whole grapheme: an emoji with its skin tone, a flag (two
 * regional indicators), a ZWJ family, a letter with its combining marks.
 * Letters are upper-cased; everything else is returned as it is. The result
 * depends only on the input and the `locale` you pass, never on the
 * runtime's default locale, so the server and the browser agree.
 *
 * Pure and dependency-free: server and client components both use it.
 */

const LETTER = /\p{L}/u;
/** Invisible characters a name can start with that are no initial at all. */
const LEADING_INVISIBLE = /^[\p{Cc}\p{Cf}\p{Z}]+/u;
/** Code points that attach to the one before them (fallback path only). */
const EXTENDER = /^[\p{M}︎️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const ZWJ = '‍';

let segmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? // Grapheme rules are not locale-tailored; a fixed locale keeps it so.
          new Intl.Segmenter('en', { granularity: 'grapheme' })
        : null;
  }
  return segmenter;
}

/**
 * The first grapheme without `Intl.Segmenter` (an older browser). Walks
 * code points (`Array.from`) and keeps whatever attaches to the first one:
 * combining marks, variation selectors, skin tones, emoji tags, a second
 * regional indicator, and ZWJ-joined code points. That matches the
 * segmenter for every case an avatar meets in practice.
 */
export function firstGraphemeFallback(text: string): string {
  const points = Array.from(text);
  const first = points[0];
  if (first === undefined) return '';
  let out = first;
  let i = 1;
  const second = points[1];
  if (REGIONAL_INDICATOR.test(first) && second !== undefined && REGIONAL_INDICATOR.test(second)) {
    out += second;
    i = 2;
  }
  while (i < points.length) {
    const point = points[i]!;
    const next = points[i + 1];
    if (point === ZWJ && next !== undefined) {
      out += point + next;
      i += 2;
      continue;
    }
    if (EXTENDER.test(point)) {
      out += point;
      i += 1;
      continue;
    }
    break;
  }
  return out;
}

/** The first user-perceived character of `text` ('' for an empty string). */
export function firstGrapheme(text: string): string {
  if (!text) return '';
  const seg = graphemeSegmenter();
  if (seg) {
    for (const { segment } of seg.segment(text)) return segment;
    return '';
  }
  return firstGraphemeFallback(text);
}

export interface InitialOptions {
  /**
   * The reader's language, for casing: "irem" is "İ" in Turkish and "I"
   * in English. Pass `t.locale`. Without it the casing is
   * locale-independent (`toUpperCase`).
   */
  locale?: string;
  /** Shown when the name has no visible character. Default "?". */
  fallback?: string;
}

/** "ada" → "A", "🎮 Gamers" → "🎮", "🇹🇷 Ece" → "🇹🇷", "" → "?". */
export function initialOf(name: string | null | undefined, options: InitialOptions = {}): string {
  const fallback = options.fallback ?? '?';
  const text = (name ?? '').trim().replace(LEADING_INVISIBLE, '');
  const grapheme = firstGrapheme(text);
  if (!grapheme) return fallback;
  if (!LETTER.test(grapheme)) return grapheme;
  let upper: string;
  try {
    upper = options.locale ? grapheme.toLocaleUpperCase(options.locale) : grapheme.toUpperCase();
  } catch {
    // An invalid locale tag must not break an avatar.
    upper = grapheme.toUpperCase();
  }
  // "ß" upper-cases to "SS" and "ﬁ" to "FI": an avatar shows one character.
  return firstGrapheme(upper) === upper ? upper : grapheme;
}
