/**
 * Interactions (docs/BOT_API_V2.md §3.3–3.4): delivering a command run to
 * its bot, and the bot's answers.
 *
 *   - `dispatchInteractionCreate` sends `interaction_create` to the bot's
 *     stream (Redis `bot-events`) and its endpoint (signed POST, ahead of
 *     every other delivery). An endpoint may answer synchronously: a 2xx
 *     body `{ "type": "respond", "content": "…", "ephemeral": true }`
 *     counts as the respond call.
 *   - `answerInteraction` is the respond / followup logic for the Bot API:
 *     bound to the bot (another bot's id → 404), answered once (409), gone
 *     after 15 minutes (410), at most 5 follow-ups. A PUBLIC answer is a
 *     normal bot message with `metadata.interaction`; an EPHEMERAL one is
 *     never stored as a message — it is kept on the interaction row and
 *     pushed to the invoker alone (Redis `user-events`, gateway topic
 *     `user:{uid}`) — and only while the invoker is still a member who can
 *     see the channel; otherwise the interaction fails for good (409
 *     `interaction_failed`) and nothing is pushed.
 */
import {
  claimBotInteractionAnswer,
  claimBotInteractionFollowup,
  expireBotInteractions,
  failBotInteractionNow,
  getBotInteractionForBot,
  listUserDisplayNames,
  pruneBotInteractions,
  releaseBotInteractionAnswer,
  releaseBotInteractionFollowup,
  type BotInteractionRow,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { botCanAccessChannel } from './access';
import { MAX_BOT_MESSAGE_LENGTH, MAX_INTERACTION_FOLLOWUPS } from './catalog';
import { deliverToEndpoint, publishBotEvent, publishUserEvent } from './events';
import { postBotMessage, toBotApiMessage, type BotApiMessage, type BotFailure, type BotResult } from './messages';
import { botHasPermission } from './permissions';
import { containsMassMention } from './settings';

function fail(status: number, code: string, error: string, extra?: Record<string, unknown>): BotFailure {
  return { ok: false, status, code, error, ...(extra ? { extra } : {}) };
}

const EXPIRED = () => fail(410, 'interaction_expired', 'This interaction has expired (15 minutes)');
const NOT_FOUND = () => fail(404, 'not_found', 'Interaction not found');

/** The `interaction_create` data payload (§4.2). */
export function interactionCreateData(interaction: BotInteractionRow, user: { id: string; displayName: string | null }) {
  return {
    event: 'interaction_create' as const,
    interaction: {
      id: interaction.id,
      commandId: interaction.commandId,
      commandName: interaction.commandName,
      options: interaction.options,
      channelId: interaction.channelId,
      user,
      expiresAt: interaction.expiresAt.toISOString(),
    },
  };
}

/** The sync answer an endpoint may return to `interaction_create`. */
export function parseSynchronousAnswer(body: Buffer): { content: string; ephemeral: boolean } | null {
  if (body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'respond' || typeof record.content !== 'string') return null;
  return { content: record.content, ephemeral: record.ephemeral === true };
}

/**
 * Deliver a new interaction to its bot — stream and endpoint, whichever
 * exist. Never throws; the invoke route has already answered 202.
 */
export async function dispatchInteractionCreate(input: {
  bot: BotRow;
  interaction: BotInteractionRow;
  user: { id: string; displayName: string | null };
}): Promise<void> {
  const { bot, interaction } = input;
  const data = interactionCreateData(interaction, input.user);
  if (botHasPermission(bot, 'receive_events')) await publishBotEvent(bot.id, data);
  let current: BotRow | null = null;
  deliverToEndpoint({
    botId: bot.id,
    serverId: bot.serverId,
    event: 'interaction_create',
    data,
    priority: 'high',
    authorize: async (latest) => {
      current = latest;
      return botHasPermission(latest, 'slash_commands') && (await botCanAccessChannel(latest, interaction.channelId)) !== null;
    },
    onResponse: async ({ body }) => {
      const answer = parseSynchronousAnswer(body);
      if (!answer || !current) return;
      const result = await answerInteraction({
        bot: current,
        interactionId: interaction.id,
        content: answer.content,
        ephemeral: answer.ephemeral,
        kind: 'respond',
      });
      if (!result.ok) console.warn(`[bot-events] synchronous answer refused: ${result.code}`);
    },
  });
}

/** The retention part of the sweep runs at most once a minute per bot (per process). */
const PRUNE_INTERVAL_MS = 60_000;
const MAX_PRUNE_ENTRIES = 10_000;
const lastPrunedAt = new Map<string, number>();

async function pruneInteractionsThrottled(botId: string, now: Date): Promise<void> {
  const last = lastPrunedAt.get(botId);
  if (last !== undefined && now.getTime() - last < PRUNE_INTERVAL_MS) return;
  if (lastPrunedAt.size >= MAX_PRUNE_ENTRIES) lastPrunedAt.clear();
  lastPrunedAt.set(botId, now.getTime());
  try {
    await pruneBotInteractions(getDb(), { botId }, now);
  } catch (err) {
    console.warn('[bots] interaction retention sweep failed:', (err as Error).message);
  }
}

/**
 * Lazy upkeep of a bot's interactions (cheap, indexed), run when a command
 * of the bot is invoked and when the bot lists its commands: overdue
 * pending rows turn `expired`; and (at most once a minute) answers of
 * expired rows are cleared and rows 24 h past expiry deleted
 * (`pruneBotInteractions`, docs/BOT_API_V2.md §3.4).
 */
export async function sweepExpiredInteractions(botId: string, now: Date = new Date()): Promise<number> {
  let expired = 0;
  try {
    expired = await expireBotInteractions(getDb(), { botId }, now);
  } catch (err) {
    console.warn('[bots] interaction sweep failed:', (err as Error).message);
  }
  await pruneInteractionsThrottled(botId, now);
  return expired;
}

/** Test-only. */
export function __resetInteractionPruning(): void {
  lastPrunedAt.clear();
}

/**
 * Whether the member who ran the command may still receive a private
 * answer in that channel: still a member (a ban removes the membership)
 * and still able to see the channel (role gates; owner / Manage Channels
 * pass). Fails closed on any error.
 */
async function invokerStillSeesChannel(row: BotInteractionRow): Promise<boolean> {
  try {
    const access = await authorizeChannelMessageAccess({
      userId: row.userId,
      serverId: row.serverId,
      channelId: row.channelId,
      operation: 'mutate',
    });
    return access.ok;
  } catch (err) {
    console.warn('[bots] invoker access check failed:', (err as Error).message);
    return false;
  }
}

export interface AnswerResult {
  interaction: { id: string; status: 'answered'; followupCount: number };
  /** The stored message, for a public answer. */
  message?: BotApiMessage;
}

/** Why a claim failed, from a fresh read of the row. */
async function explainRefusal(
  interactionId: string,
  botId: string,
  kind: 'respond' | 'followup',
  now: Date
): Promise<BotFailure> {
  const row = await getBotInteractionForBot(getDb(), interactionId, botId);
  if (!row) return NOT_FOUND();
  if (row.status === 'expired' || row.expiresAt <= now) return EXPIRED();
  if (row.status === 'failed') return fail(409, 'interaction_failed', 'This interaction can no longer be answered');
  if (kind === 'respond') return fail(409, 'interaction_already_answered', 'This interaction was already answered');
  if (row.status === 'pending') return fail(409, 'interaction_not_answered', 'Respond to the interaction before following up');
  return fail(409, 'followup_limit_reached', `At most ${MAX_INTERACTION_FOLLOWUPS} follow-ups per interaction`);
}

/**
 * Respond to (once) or follow up on an interaction, as the bot. All checks
 * run before the atomic claim, so a refused answer never consumes it.
 */
export async function answerInteraction(input: {
  bot: BotRow;
  interactionId: string;
  content: string;
  ephemeral: boolean;
  kind: 'respond' | 'followup';
}): Promise<BotResult<AnswerResult>> {
  const { bot, kind, ephemeral } = input;
  if (!bot.enabled) return fail(403, 'bot_disabled', 'This bot is disabled');
  if (!botHasPermission(bot, 'slash_commands')) {
    return fail(403, 'missing_permission', 'This bot lacks the slash_commands permission', { permission: 'slash_commands' });
  }
  if (!ephemeral && !botHasPermission(bot, 'send_messages')) {
    return fail(403, 'missing_permission', 'A public answer needs the send_messages permission', { permission: 'send_messages' });
  }
  const content = input.content.trim();
  if (!content || content.length > MAX_BOT_MESSAGE_LENGTH) {
    return fail(400, 'invalid_request', `content must be 1–${MAX_BOT_MESSAGE_LENGTH} characters`, { issues: ['content'] });
  }
  // A private answer pings nobody; a public one is a channel message.
  if (!ephemeral && containsMassMention(content)) {
    return fail(403, 'mass_mention_forbidden', 'Bots cannot mention @everyone or @here');
  }

  const now = new Date();
  const row = await getBotInteractionForBot(getDb(), input.interactionId, bot.id);
  if (!row) return NOT_FOUND();
  if (row.expiresAt <= now || row.status === 'expired') {
    if (row.status === 'pending') await sweepExpiredInteractions(bot.id, now);
    return EXPIRED();
  }
  if (row.status === 'failed') return fail(409, 'interaction_failed', 'This interaction can no longer be answered');
  if (kind === 'respond' && row.status !== 'pending') {
    return fail(409, 'interaction_already_answered', 'This interaction was already answered');
  }
  if (kind === 'followup') {
    if (row.status === 'pending') return fail(409, 'interaction_not_answered', 'Respond to the interaction before following up');
    if (row.followupCount >= MAX_INTERACTION_FOLLOWUPS) {
      return fail(409, 'followup_limit_reached', `At most ${MAX_INTERACTION_FOLLOWUPS} follow-ups per interaction`);
    }
  }
  // Access may have been revoked since the command ran.
  if (!(await botCanAccessChannel(bot, row.channelId))) {
    return fail(404, 'not_found', 'Channel not found, or not available to bots');
  }

  const claimed =
    kind === 'respond'
      ? await claimBotInteractionAnswer(getDb(), { interactionId: row.id, botId: bot.id, response: { content, ephemeral } }, now)
      : await claimBotInteractionFollowup(getDb(), { interactionId: row.id, botId: bot.id, maxFollowups: MAX_INTERACTION_FOLLOWUPS }, now);
  if (!claimed) return explainRefusal(row.id, bot.id, kind, now);

  const release = async () => {
    if (kind === 'respond') await releaseBotInteractionAnswer(getDb(), { interactionId: row.id, botId: bot.id, answeredAt: now });
    else await releaseBotInteractionFollowup(getDb(), { interactionId: row.id, botId: bot.id });
  };
  const summary = { id: row.id, status: 'answered' as const, followupCount: claimed.followupCount };

  if (ephemeral) {
    // The invoker may have left, been banned or lost the channel since the
    // command ran: a private answer must not reach them then. The
    // interaction is over (failed, its stored answer dropped).
    if (!(await invokerStillSeesChannel(row))) {
      await failBotInteractionNow(getDb(), row.id, bot.id);
      return fail(409, 'interaction_failed', 'This interaction can no longer be answered');
    }
    await publishUserEvent(row.userId, {
      type: 'interaction_response',
      interaction: {
        id: row.id,
        serverId: row.serverId,
        channelId: row.channelId,
        commandName: row.commandName,
        bot: { id: bot.id, name: bot.name },
      },
      response: { content, ephemeral: true, followup: kind === 'followup' },
    });
    return { ok: true, value: { interaction: summary } };
  }

  const names = await listUserDisplayNames(getDb(), [row.userId]);
  let posted: Awaited<ReturnType<typeof postBotMessage>>;
  try {
    posted = await postBotMessage({
      bot,
      channelId: row.channelId,
      content,
      metadata: {
        interaction: {
          id: row.id,
          commandName: row.commandName,
          invokedBy: { id: row.userId, displayName: names.get(row.userId) ?? null },
          ...(kind === 'followup' ? { followup: true } : {}),
        },
      },
    });
  } catch (err) {
    await release();
    throw err;
  }
  if (!posted.ok) {
    await release();
    return posted;
  }
  return { ok: true, value: { interaction: summary, message: toBotApiMessage(posted.value, new Map()) } };
}
