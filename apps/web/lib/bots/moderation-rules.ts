/**
 * The Moderation Bot's content rules — pure functions, no I/O.
 *
 * Normalisation is case- and Turkish-aware: every I-family letter
 * (I, İ, ı, i) folds to `i`, so a blocked `sik` catches `SIK`, `SİK` and
 * `sık`, and the classic `'İ'.toLowerCase() === 'i̇'` trap cannot open a
 * gap. Compatibility forms fold (NFKC: fullwidth `ｓｐａｍ` → `spam`) and
 * invisible characters (zero-width space, soft hyphen, bidi controls) are
 * dropped, since they are the cheapest way around a filter. Other letters
 * keep their marks (ş ≠ s): folding them would make `göt` block `got`.
 *
 * Matching is by whole word, so `ass` does not block `class`. A `*`
 * widens a word on that side: `salak*` also blocks `salaksın` (Turkish
 * suffixes), `*spam` blocks `antispam`, `*spam*` blocks any word
 * containing it. An entry with spaces is a phrase: consecutive words.
 */
import type { ModerationSettings } from './settings';

export type ModerationRule = 'blocked_word' | 'link' | 'mentions' | 'repeat' | 'flood';

export interface ContentViolation {
  rule: ModerationRule;
  /** What matched: the blocked-word entry, the link host, the mention count. */
  detail: string;
}

const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** Strip what a reader cannot see, and fold compatibility forms. */
function cleanText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

export function normalizeForModeration(text: string): string {
  return cleanText(text)
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/̇/g, '');
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Blocked words
// ---------------------------------------------------------------------------

export interface WordRule {
  /** The entry as the admin wrote it (reported in the audit log). */
  source: string;
  /** A `*` before the first word / after the last one. */
  leading: boolean;
  trailing: boolean;
  tokens: string[];
}

export function compileBlockedWords(words: readonly string[]): WordRule[] {
  const rules: WordRule[] = [];
  for (const word of words) {
    const trimmed = word.trim();
    const leading = trimmed.startsWith('*');
    const trailing = trimmed.endsWith('*');
    const tokens = tokenize(normalizeForModeration(trimmed.replace(/^\*+|\*+$/g, '')));
    if (tokens.length === 0) continue;
    rules.push({ source: trimmed, leading, trailing, tokens });
  }
  return rules;
}

function tokenMatches(token: string, expected: string, lead: boolean, trail: boolean): boolean {
  if (lead && trail) return token.includes(expected);
  if (lead) return token.endsWith(expected);
  if (trail) return token.startsWith(expected);
  return token === expected;
}

/** The first blocked-word entry the content hits, or null. */
export function findBlockedWord(content: string, rules: readonly WordRule[]): string | null {
  if (rules.length === 0) return null;
  const tokens = tokenize(normalizeForModeration(content));
  if (tokens.length === 0) return null;
  const present = new Set(tokens);
  for (const rule of rules) {
    const n = rule.tokens.length;
    if (n === 1 && !rule.leading && !rule.trailing) {
      if (present.has(rule.tokens[0]!)) return rule.source;
      continue;
    }
    for (let start = 0; start + n <= tokens.length; start += 1) {
      let matched = true;
      for (let j = 0; j < n; j += 1) {
        const lead = rule.leading && j === 0;
        const trail = rule.trailing && j === n - 1;
        if (!tokenMatches(tokens[start + j]!, rule.tokens[j]!, lead, trail)) {
          matched = false;
          break;
        }
      }
      if (matched) return rule.source;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Bare `name.tld` counts as a link only for these endings — the common
 * and the commonly abused ones — so `node.js` or `notes.txt` are not
 * "links". Anything with a scheme (`https://…`) or `www.` always is.
 */
const LINK_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'tv', 'gg', 'xyz', 'app', 'dev', 'ai', 'ly', 'to',
  'cc', 'sh', 'so', 'fm', 'am', 'ws', 'su', 'eu', 'us', 'uk', 'de', 'fr', 'nl', 'be', 'at', 'ch', 'it', 'es',
  'pt', 'pl', 'cz', 'ro', 'hu', 'gr', 'se', 'no', 'fi', 'dk', 'ru', 'ua', 'by', 'kz', 'az', 'tr', 'ir', 'il',
  'ae', 'sa', 'in', 'jp', 'cn', 'kr', 'au', 'ca', 'br', 'mx', 'ar', 'tk', 'ml', 'ga', 'cf', 'gq', 'link',
  'click', 'top', 'site', 'online', 'shop', 'store', 'live', 'club', 'pro', 'news', 'blog', 'page', 'tech',
  'wiki', 'fun', 'space', 'website', 'world', 'zone', 'icu', 'vip', 'win', 'bid', 'stream', 'download',
  'gift', 'gifts', 'lol', 'media', 'social', 'chat', 'games', 'group', 'cloud', 'host', 'email', 'art',
];

const SCHEME_URL = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu;
const WWW_URL = /(?<![\p{L}\p{N}._-])www\.[^\s<>"'`]+/giu;
const BARE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${LINK_TLDS.join('|')})(?![\\p{L}\\p{N}_-])(?:[/:?#][^\\s<>"'\`]*)?`,
  'giu'
);

function hostOf(candidate: string): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
    return url.hostname.replace(/\.$/, '').replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Hosts of every link in the text ('' for a link whose host cannot be read). */
export function extractLinkHosts(content: string): string[] {
  let text = cleanText(content);
  const hosts: string[] = [];
  for (const pattern of [SCHEME_URL, WWW_URL, BARE_DOMAIN]) {
    text = text.replace(pattern, (match) => {
      hosts.push(hostOf(match.replace(/[.,;:!?)\]}]+$/, '')));
      return ' '.repeat(match.length);
    });
  }
  return hosts;
}

export function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  if (!host) return false;
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/** `@name`, `@everyone` and `@here` at the start of a word each count once. */
export function countMentions(content: string): number {
  return (cleanText(content).match(/(?:^|\s)@(?=[\p{L}\p{N}_])/gu) ?? []).length;
}

// ---------------------------------------------------------------------------
// All content rules
// ---------------------------------------------------------------------------

/**
 * Blocked words, then links, then mass mentions. The counting rules
 * (flood, repeat) need state and live in `moderation.ts`.
 */
export function evaluateContentRules(
  content: string,
  settings: Pick<ModerationSettings, 'linkPolicy' | 'allowedDomains' | 'maxMentions'>,
  words: readonly WordRule[]
): ContentViolation | null {
  const word = findBlockedWord(content, words);
  if (word) return { rule: 'blocked_word', detail: word };

  if (settings.linkPolicy !== 'allow') {
    const hosts = extractLinkHosts(content);
    if (hosts.length > 0) {
      if (settings.linkPolicy === 'block') return { rule: 'link', detail: hosts[0] || 'link' };
      const refused = hosts.find((host) => !isHostAllowed(host, settings.allowedDomains));
      if (refused !== undefined) return { rule: 'link', detail: refused || 'link' };
    }
  }

  if (settings.maxMentions > 0) {
    const mentions = countMentions(content);
    if (mentions > settings.maxMentions) return { rule: 'mentions', detail: String(mentions) };
  }
  return null;
}

/** Canonical form of a message for the "same message again" rule. */
export function repeatKey(content: string): string {
  return normalizeForModeration(content).replace(/\s+/g, ' ').trim();
}
