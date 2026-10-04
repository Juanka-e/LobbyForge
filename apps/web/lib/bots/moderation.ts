/**
 * The Moderation Bot — runs inside the messages route, before a member's
 * message is stored.
 *
 *   1. No enabled Moderation Bot with `moderate_messages` → allow. The bot
 *      row comes from a 15 s cache, so a server without the bot pays
 *      nothing per message.
 *   2. Content rules (pure, fast): blocked words, link policy, mentions.
 *   3. Counting rules, new messages only: the same message again
 *      (`repeat`) and too many messages (`flood`), both on the app's
 *      rate-limit counters.
 *   4. A hit by staff (owner / administrator / moderator) is let through
 *      when `exemptStaff` is on — checked last, so a clean message never
 *      pays for the permission lookup.
 *   5. Otherwise: block. Always an audit entry (rule, what matched, a
 *      trimmed excerpt and a hash of the message, the member); optionally
 *      a short neutral notice in the channel (at most one per member per
 *      channel per minute, so a flood cannot turn into a notice flood).
 *
 * Failing to LOAD the bot fails open (a filter outage must not take chat
 * down); a hit is always enforced.
 */
import { createHash } from 'node:crypto';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getUserPermissions, isChannelOpenToBots, listUserDisplayNames, logAction, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { distributedRateLimit } from '@/lib/security-headers';
import { getBuiltInBot } from './cache';
import { botHasPermission } from './permissions';
import {
  compileBlockedWords,
  evaluateContentRules,
  repeatKey,
  type ContentViolation,
  type ModerationRule,
  type WordRule,
} from './moderation-rules';
import { parseModerationSettings, type ModerationSettings } from './settings';
import { postBotMessage } from './messages';
import { defaultBotText, renderBotTemplate } from './templates';

export interface ModerateInput {
  serverId: string;
  channelId: string;
  userId: string;
  content: string;
  ownerUserId: string | null;
  /** Edits run the content rules only — the counting rules are for new messages. */
  kind?: 'create' | 'edit';
}

export type ModerationVerdict =
  | { action: 'allow' }
  | { action: 'block'; rule: ModerationRule; botId: string; botName: string };

const ALLOW: ModerationVerdict = { action: 'allow' };
const EXCERPT_LENGTH = 120;
const NOTICE_WINDOW_MS = 60_000;

/** Compiled blocked-word lists, per bot version (settings change → new key). */
const compiled = new Map<string, WordRule[]>();

function wordRulesFor(bot: BotRow, settings: ModerationSettings): WordRule[] {
  const key = `${bot.id}:${bot.updatedAt.getTime()}`;
  const hit = compiled.get(key);
  if (hit) return hit;
  const rules = compileBlockedWords(settings.blockedWords);
  if (compiled.size >= 500) compiled.clear();
  compiled.set(key, rules);
  return rules;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function excerptOf(content: string): string {
  const flat = content.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat;
}

async function checkCountingRules(
  input: ModerateInput,
  settings: ModerationSettings
): Promise<ContentViolation | null> {
  if (settings.repeat) {
    const fingerprint = sha256(repeatKey(input.content)).slice(0, 32);
    const result = await distributedRateLimit(`bot-mod-repeat:${input.serverId}:${input.userId}:${fingerprint}`, {
      windowMs: settings.repeat.windowSeconds * 1000,
      maxRequests: settings.repeat.max,
    });
    if (!result.allowed) {
      return { rule: 'repeat', detail: `${settings.repeat.max}/${settings.repeat.windowSeconds}s` };
    }
  }
  if (settings.flood) {
    const result = await distributedRateLimit(`bot-mod-flood:${input.serverId}:${input.userId}`, {
      windowMs: settings.flood.windowSeconds * 1000,
      maxRequests: settings.flood.max,
    });
    if (!result.allowed) {
      return { rule: 'flood', detail: `${settings.flood.max}/${settings.flood.windowSeconds}s` };
    }
  }
  return null;
}

/** Owner, administrators and moderators (manage messages / server / members). */
async function isStaff(input: ModerateInput): Promise<boolean> {
  if (input.ownerUserId && input.ownerUserId === input.userId) return true;
  const permissions = await getUserPermissions(getDb(), input.userId, input.serverId);
  return (
    hasPermission(permissions, CorePermission.MANAGE_MESSAGES) ||
    hasPermission(permissions, CorePermission.MANAGE_SERVER) ||
    hasPermission(permissions, CorePermission.MODERATE_MEMBERS)
  );
}

async function recordBlock(bot: BotRow, input: ModerateInput, violation: ContentViolation): Promise<void> {
  // The audit log is read by everyone with VIEW_AUDIT_LOG, who may not see
  // a role-gated channel: its words stay out (the hash still identifies it).
  const openChannel = await isChannelOpenToBots(getDb(), input.channelId).catch(() => false);
  await logAction(getDb(), {
    serverId: input.serverId,
    actorUserId: null,
    action: 'bot.moderation.block',
    targetType: 'user',
    targetId: input.userId,
    metadata: {
      botId: bot.id,
      botName: bot.name,
      rule: violation.rule,
      detail: violation.detail,
      channelId: input.channelId,
      kind: input.kind ?? 'create',
      excerpt: openChannel ? excerptOf(input.content) : null,
      contentSha256: sha256(input.content),
    },
  }).catch((err) => console.error('[audit] bot.moderation.block failed:', (err as Error).message));
}

async function postNotice(bot: BotRow, settings: ModerationSettings, input: ModerateInput): Promise<void> {
  if (!botHasPermission(bot, 'send_messages')) return;
  const gate = await distributedRateLimit(
    `bot-mod-notice:${input.serverId}:${input.channelId}:${input.userId}`,
    { windowMs: NOTICE_WINDOW_MS, maxRequests: 1 }
  );
  if (!gate.allowed) return;
  // security-review FILE-001: the name only — a full user row would carry
  // the member's avatar and banner data URLs (up to ~14 MB) for one word.
  const names = await listUserDisplayNames(getDb(), [input.userId]);
  const template = settings.noticeTemplate ?? defaultBotText('bots.moderation.defaultNotice');
  const content = renderBotTemplate(template, { user: names.get(input.userId) ?? '' });
  if (!content) return;
  const posted = await postBotMessage({ bot, channelId: input.channelId, content });
  if (!posted.ok) console.warn(`[bots] moderation notice not posted: ${posted.code}`);
}

export async function moderateMessage(input: ModerateInput): Promise<ModerationVerdict> {
  let bot: BotRow | null;
  try {
    bot = await getBuiltInBot(input.serverId, 'moderation');
  } catch (err) {
    console.error('[bots] moderation bot unavailable, message allowed:', (err as Error).message);
    return ALLOW;
  }
  if (!bot || !bot.enabled || !botHasPermission(bot, 'moderate_messages')) return ALLOW;

  const settings = parseModerationSettings(bot.settings);
  let violation = evaluateContentRules(input.content, settings, wordRulesFor(bot, settings));
  if (!violation && (input.kind ?? 'create') === 'create') {
    violation = await checkCountingRules(input, settings);
  }
  if (!violation) return ALLOW;
  if (settings.exemptStaff && (await isStaff(input))) return ALLOW;

  await recordBlock(bot, input, violation);
  if (settings.postNotice) {
    void postNotice(bot, settings, input).catch((err) =>
      console.error('[bots] moderation notice failed:', (err as Error).message)
    );
  }
  return { action: 'block', rule: violation.rule, botId: bot.id, botName: bot.name };
}

/**
 * Bot API v2 §5.1: a post from an incoming channel webhook goes through the
 * same Moderation Bot. Webhooks are not members, so:
 *   - the CONTENT rules run (blocked words, links, mentions); the counting
 *     rules do not — a webhook has its own 30/min limit at the route;
 *   - there is no staff exemption (a webhook has no roles);
 *   - the audit entry names the webhook (`targetType: 'webhook'`), and the
 *     optional notice uses the webhook's name.
 * Fails open on a bot that cannot be loaded, like member messages.
 */
export async function moderateWebhookMessage(input: {
  serverId: string;
  channelId: string;
  webhook: { id: string; name: string };
  content: string;
}): Promise<ModerationVerdict> {
  let bot: BotRow | null;
  try {
    bot = await getBuiltInBot(input.serverId, 'moderation');
  } catch (err) {
    console.error('[bots] moderation bot unavailable, webhook post allowed:', (err as Error).message);
    return ALLOW;
  }
  if (!bot || !bot.enabled || !botHasPermission(bot, 'moderate_messages')) return ALLOW;
  const settings = parseModerationSettings(bot.settings);
  const violation = evaluateContentRules(input.content, settings, wordRulesFor(bot, settings));
  if (!violation) return ALLOW;

  const openChannel = await isChannelOpenToBots(getDb(), input.channelId).catch(() => false);
  await logAction(getDb(), {
    serverId: input.serverId,
    actorUserId: null,
    action: 'bot.moderation.block',
    targetType: 'webhook',
    targetId: input.webhook.id,
    metadata: {
      botId: bot.id,
      botName: bot.name,
      rule: violation.rule,
      detail: violation.detail,
      channelId: input.channelId,
      kind: 'webhook',
      webhookName: input.webhook.name,
      excerpt: openChannel ? excerptOf(input.content) : null,
      contentSha256: sha256(input.content),
    },
  }).catch((err) => console.error('[audit] bot.moderation.block failed:', (err as Error).message));

  if (settings.postNotice && botHasPermission(bot, 'send_messages')) {
    const moderationBot = bot;
    void (async () => {
      const gate = await distributedRateLimit(
        `bot-mod-notice:${input.serverId}:${input.channelId}:webhook:${input.webhook.id}`,
        { windowMs: NOTICE_WINDOW_MS, maxRequests: 1 }
      );
      if (!gate.allowed) return;
      const template = settings.noticeTemplate ?? defaultBotText('bots.moderation.defaultNotice');
      const content = renderBotTemplate(template, { user: input.webhook.name });
      if (!content) return;
      const posted = await postBotMessage({ bot: moderationBot, channelId: input.channelId, content });
      if (!posted.ok) console.warn(`[bots] moderation notice not posted: ${posted.code}`);
    })().catch((err) => console.error('[bots] moderation notice failed:', (err as Error).message));
  }
  return { action: 'block', rule: violation.rule, botId: bot.id, botName: bot.name };
}

/** The error a blocked sender gets; the lobby translates it by `code` + `rule`. */
export function moderationBlockedBody(verdict: Extract<ModerationVerdict, { action: 'block' }>) {
  return {
    error: 'Your message was blocked by the moderation bot',
    code: 'blocked_by_moderation',
    rule: verdict.rule,
    bot: { id: verdict.botId, name: verdict.botName },
  };
}

/** Test-only. */
export function __resetModerationCaches(): void {
  compiled.clear();
}
