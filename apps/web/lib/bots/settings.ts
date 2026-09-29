/**
 * Settings of the built-in bots, stored in `bots.settings` (JSONB).
 *
 * Two layers:
 *   - `*SettingsInputSchema`  strict zod schemas for what an admin may SEND;
 *   - `parse*Settings(raw)`   tolerant readers for what is STORED — a row
 *     written by an older version (or by hand) reads as the nearest valid
 *     settings, never as an exception in the message path.
 * Client-safe (zod only): the admin page shares the types and defaults.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const TEMPLATE_MAX_LENGTH = 500;

/** `@everyone` / `@here` — a bot may never ping the whole server. */
export function containsMassMention(text: string): boolean {
  // NFKC first: a fullwidth `＠everyone` is still @everyone to a reader.
  return /(^|[^\p{L}\p{N}_])@(everyone|here)(?![\p{L}\p{N}_])/iu.test(text.normalize('NFKC'));
}

const templateSchema = z
  .string()
  .max(TEMPLATE_MAX_LENGTH)
  .transform((value) => value.trim())
  .refine((value) => !containsMassMention(value), { message: 'Templates cannot mention @everyone or @here' })
  .transform((value) => (value ? value : null))
  .nullable();

// ---------------------------------------------------------------------------
// Welcome Bot
// ---------------------------------------------------------------------------

export interface WelcomeSettings {
  /** Where greetings go; null = the first text channel open to bots. */
  channelId: string | null;
  /** `{user}` and `{server}` are filled in; null = the default greeting. */
  template: string | null;
}

export const DEFAULT_WELCOME_SETTINGS: WelcomeSettings = { channelId: null, template: null };

export const WelcomeSettingsInputSchema = z
  .object({
    channelId: z.string().uuid().nullable(),
    template: templateSchema,
  })
  .strict()
  .partial();

export type WelcomeSettingsInput = z.infer<typeof WelcomeSettingsInputSchema>;

export function parseWelcomeSettings(raw: unknown): WelcomeSettings {
  const record = asRecord(raw);
  const channelId =
    typeof record.channelId === 'string' && z.string().uuid().safeParse(record.channelId).success
      ? record.channelId
      : null;
  const template =
    typeof record.template === 'string' && record.template.trim()
      ? record.template.trim().slice(0, TEMPLATE_MAX_LENGTH)
      : null;
  return { channelId, template };
}

// ---------------------------------------------------------------------------
// Moderation Bot
// ---------------------------------------------------------------------------

export const LINK_POLICIES = ['allow', 'block', 'allowlist'] as const;
export type LinkPolicy = (typeof LINK_POLICIES)[number];

export interface RateRule {
  /** Most messages allowed inside the window (the next one is blocked). */
  max: number;
  windowSeconds: number;
}

export interface ModerationSettings {
  /** Words / phrases; `word*` also catches suffixed forms (`salak*` → `salaksın`). */
  blockedWords: string[];
  linkPolicy: LinkPolicy;
  /** For `allowlist`: these hosts and their subdomains are allowed. */
  allowedDomains: string[];
  /** Most @mentions in one message; 0 = no limit. */
  maxMentions: number;
  /** Too many messages from one member, server-wide; null = off. */
  flood: RateRule | null;
  /** The same message again and again; null = off. */
  repeat: RateRule | null;
  /** The owner, administrators and moderators skip every rule. */
  exemptStaff: boolean;
  /** Post a short neutral notice in the channel when a message is blocked. */
  postNotice: boolean;
  /** `{user}` is filled in; null = the default notice. */
  noticeTemplate: string | null;
}

export const MODERATION_LIMITS = {
  blockedWords: 500,
  blockedWordLength: 64,
  allowedDomains: 100,
  maxMentions: 50,
  floodMax: { min: 2, max: 50 },
  floodWindow: { min: 2, max: 300 },
  repeatMax: { min: 1, max: 20 },
  repeatWindow: { min: 5, max: 3600 },
} as const;

export const DEFAULT_MODERATION_SETTINGS: ModerationSettings = {
  blockedWords: [],
  linkPolicy: 'allow',
  allowedDomains: [],
  maxMentions: 8,
  flood: { max: 6, windowSeconds: 10 },
  repeat: { max: 3, windowSeconds: 60 },
  exemptStaff: true,
  postNotice: false,
  noticeTemplate: null,
};

/**
 * A blocked-word entry as the admin typed it, tidied: trimmed, inner
 * whitespace collapsed. Wildcards (`*`) stay. Empty or wildcard-only
 * entries are dropped. Duplicates (case-insensitively) are dropped.
 */
export function normalizeBlockedWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    if (typeof raw !== 'string') continue;
    const word = raw.replace(/\s+/g, ' ').trim().slice(0, MODERATION_LIMITS.blockedWordLength);
    if (!/[\p{L}\p{N}]/u.test(word)) continue;
    const key = word.toLocaleLowerCase('tr').replace(/ı/g, 'i');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MODERATION_LIMITS.blockedWords) break;
  }
  return out;
}

/**
 * `https://www.Example.com/path` → `example.com`. Returns null for
 * anything that is not a plausible host name. IDNs come back in their
 * ASCII (punycode) form — the same form link detection compares.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^\*\./, '');
  value = value.split(/[/?#]/, 1)[0] ?? '';
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host.includes('.') || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((label) => !label || label.length > 63)) return null;
  return host;
}

const rateRuleSchema = (max: { min: number; max: number }, window: { min: number; max: number }) =>
  z
    .object({
      max: z.number().int().min(max.min).max(max.max),
      windowSeconds: z.number().int().min(window.min).max(window.max),
    })
    .strict()
    .nullable();

export const ModerationSettingsInputSchema = z
  .object({
    blockedWords: z
      .array(z.string().max(MODERATION_LIMITS.blockedWordLength))
      .max(MODERATION_LIMITS.blockedWords)
      .transform((words) => normalizeBlockedWords(words)),
    linkPolicy: z.enum(LINK_POLICIES),
    allowedDomains: z
      .array(z.string().max(253))
      .max(MODERATION_LIMITS.allowedDomains)
      .superRefine((domains, ctx) => {
        domains.forEach((domain, index) => {
          if (!normalizeDomain(domain)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a domain: ${domain}`, path: [index] });
          }
        });
      })
      .transform((domains) => Array.from(new Set(domains.map((d) => normalizeDomain(d)!)))),
    maxMentions: z.number().int().min(0).max(MODERATION_LIMITS.maxMentions),
    flood: rateRuleSchema(MODERATION_LIMITS.floodMax, MODERATION_LIMITS.floodWindow),
    repeat: rateRuleSchema(MODERATION_LIMITS.repeatMax, MODERATION_LIMITS.repeatWindow),
    exemptStaff: z.boolean(),
    postNotice: z.boolean(),
    noticeTemplate: templateSchema,
  })
  .strict()
  .partial();

export type ModerationSettingsInput = z.infer<typeof ModerationSettingsInputSchema>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseRateRule(
  raw: unknown,
  fallback: RateRule | null,
  max: { min: number; max: number },
  window: { min: number; max: number }
): RateRule | null {
  if (raw === null) return null;
  const record = asRecord(raw);
  if (!('max' in record) && !('windowSeconds' in record)) return fallback;
  return {
    max: clampInt(record.max, max.min, max.max, fallback?.max ?? max.min),
    windowSeconds: clampInt(record.windowSeconds, window.min, window.max, fallback?.windowSeconds ?? window.min),
  };
}

export function parseModerationSettings(raw: unknown): ModerationSettings {
  const record = asRecord(raw);
  const d = DEFAULT_MODERATION_SETTINGS;
  const blockedWords = Array.isArray(record.blockedWords)
    ? normalizeBlockedWords(record.blockedWords.filter((w): w is string => typeof w === 'string'))
    : d.blockedWords;
  const linkPolicy = (LINK_POLICIES as readonly unknown[]).includes(record.linkPolicy)
    ? (record.linkPolicy as LinkPolicy)
    : d.linkPolicy;
  const allowedDomains = Array.isArray(record.allowedDomains)
    ? Array.from(
        new Set(
          record.allowedDomains
            .filter((x): x is string => typeof x === 'string')
            .map((x) => normalizeDomain(x))
            .filter((x): x is string => Boolean(x))
        )
      ).slice(0, MODERATION_LIMITS.allowedDomains)
    : d.allowedDomains;
  return {
    blockedWords,
    linkPolicy,
    allowedDomains,
    maxMentions: 'maxMentions' in record ? clampInt(record.maxMentions, 0, MODERATION_LIMITS.maxMentions, d.maxMentions) : d.maxMentions,
    flood: 'flood' in record
      ? parseRateRule(record.flood, d.flood, MODERATION_LIMITS.floodMax, MODERATION_LIMITS.floodWindow)
      : d.flood,
    repeat: 'repeat' in record
      ? parseRateRule(record.repeat, d.repeat, MODERATION_LIMITS.repeatMax, MODERATION_LIMITS.repeatWindow)
      : d.repeat,
    exemptStaff: typeof record.exemptStaff === 'boolean' ? record.exemptStaff : d.exemptStaff,
    postNotice: typeof record.postNotice === 'boolean' ? record.postNotice : d.postNotice,
    noticeTemplate:
      typeof record.noticeTemplate === 'string' && record.noticeTemplate.trim()
        ? record.noticeTemplate.trim().slice(0, TEMPLATE_MAX_LENGTH)
        : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
