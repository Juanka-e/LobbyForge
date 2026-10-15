/**
 * Member mentions in chat (docs/PROFILES.md "Mentions"). Client-safe.
 *
 * A message's text stays plain (`hi @Ada Lovelace`) — bots, notifications,
 * search and older clients read it as before. Who a mention names is kept
 * beside it, in `metadata.mentions`: `[{ userId, text }]`, where `text` is
 * what follows the `@` in the content. The server writes it (from the
 * composer's picks and from typed `@handles`, checked against the
 * community's members); the lobby turns each `@text` into a chip that
 * opens that member's profile card.
 */

export interface StoredMention {
  userId: string;
  /** What follows `@` in the content: a display name, nickname or handle. */
  text: string;
}

/** Most mentions one message keeps. */
export const MAX_MENTIONS = 20;

/** A handle after `@`: 2–32 of a-z 0-9 _ . (case-insensitive when typed). */
const HANDLE_MENTION = /(^|[^\p{L}\p{N}_.@])@([A-Za-z0-9_.]{2,32})(?![\p{L}\p{N}_])/gu;

/** Letters, digits and `_` — what may not touch a mention on either side. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/**
 * The handles typed in a text (`@ada_l`), lowercased, without a trailing
 * dot (`hi @ada.` names `ada`), at most `MAX_MENTIONS`. Mass mentions
 * (`@everyone`, `@here`) are not handles.
 */
export function findHandleMentions(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.normalize('NFKC').matchAll(HANDLE_MENTION)) {
    const handle = match[2]!.replace(/\.+$/, '').toLowerCase();
    if (handle.length < 2 || handle === 'everyone' || handle === 'here') continue;
    found.add(handle);
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

/**
 * Where `@label` stands as a mention in `content`: nothing word-like right
 * before the `@` or right after the label (so `@Ada` is not inside
 * `@Adam`, nor `x@Ada` an address). Case-insensitive.
 */
export function mentionPositions(content: string, label: string): number[] {
  if (!label) return [];
  // Case-insensitive only while lowercasing keeps every index in place
  // (`İ` lowercases to two code units); otherwise an exact match.
  const lowerContent = content.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const folded = lowerContent.length === content.length && lowerLabel.length === label.length;
  const haystack = folded ? lowerContent : content;
  const needle = `@${folded ? lowerLabel : label}`;
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    const before = index > 0 ? content[index - 1] : undefined;
    const after = content[index + needle.length];
    if (!isWordChar(before) && before !== '@' && !isWordChar(after)) positions.push(index);
    from = index + 1;
  }
  return positions;
}

export function contentMentions(content: string, label: string): boolean {
  return mentionPositions(content, label).length > 0;
}

/** `metadata.mentions` as stored, or [] for anything else (older rows, bots). */
export function readMessageMentions(metadata: unknown): StoredMention[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { mentions?: unknown }).mentions;
  if (!Array.isArray(raw)) return [];
  const out: StoredMention[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { userId, text } = entry as { userId?: unknown; text?: unknown };
    if (typeof userId === 'string' && typeof text === 'string' && text.length > 0 && text.length <= 64) {
      out.push({ userId, text });
    }
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string }
  | { kind: 'mass'; text: string };

const MASS_MENTION = /(^|[^\p{L}\p{N}_])@(everyone|here)(?![\p{L}\p{N}_])/giu;

/**
 * The content cut into text, member mentions and `@everyone` / `@here`.
 * A longer label wins where two start at the same place (`@Ada Lovelace`
 * over `@Ada`); overlapping matches after the first are dropped.
 */
export function splitMentions(content: string, mentions: readonly StoredMention[]): MentionSegment[] {
  type Hit = { start: number; end: number; segment: MentionSegment };
  const hits: Hit[] = [];
  for (const mention of mentions) {
    for (const start of mentionPositions(content, mention.text)) {
      const end = start + 1 + mention.text.length;
      hits.push({ start, end, segment: { kind: 'mention', text: content.slice(start, end), userId: mention.userId } });
    }
  }
  for (const match of content.matchAll(MASS_MENTION)) {
    const start = match.index! + match[1]!.length;
    const end = start + 1 + match[2]!.length;
    hits.push({ start, end, segment: { kind: 'mass', text: content.slice(start, end) } });
  }
  if (hits.length === 0) return content ? [{ kind: 'text', text: content }] : [];
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) segments.push({ kind: 'text', text: content.slice(cursor, hit.start) });
    segments.push(hit.segment);
    cursor = hit.end;
  }
  if (cursor < content.length) segments.push({ kind: 'text', text: content.slice(cursor) });
  return segments;
}
