import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { BotRow } from '@lobbyforge/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, readJsonBody, withBotAuth } from '@/lib/bots/api';
import { postBotMessage, readMessagesForBot, toBotApiMessage } from '@/lib/bots/messages';
import { MAX_BOT_MESSAGE_LENGTH } from '@/lib/bots/catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ channelId: string }> };

const ChannelIdSchema = z.string().uuid();

const PostMessageSchema = z
  .object({
    content: z
      .string()
      .refine((value) => value.trim().length > 0, 'content must not be empty')
      .refine((value) => value.length <= MAX_BOT_MESSAGE_LENGTH, `content must be at most ${MAX_BOT_MESSAGE_LENGTH} characters`),
  })
  .strict();

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
}

async function channelIdFrom(ctx: RouteContext): Promise<string | null> {
  const { channelId } = await ctx.params;
  return ChannelIdSchema.safeParse(channelId).success ? channelId : null;
}

/**
 * GET /api/bot/v1/channels/{channelId}/messages?limit=50&before=<ISO>
 * Recent messages, newest first. Needs `read_messages`.
 */
async function handleGet(req: Request, ctx: RouteContext, bot: BotRow): Promise<NextResponse> {
  const channelId = await channelIdFrom(ctx);
  if (!channelId) return botError(404, 'not_found', 'Channel not found, or not available to bots');

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  let limit = 50;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!/^\d+$/.test(limitParam) || limit < 1 || limit > 100) {
      return botError(400, 'invalid_request', 'limit must be an integer from 1 to 100', { issues: ['limit'] });
    }
  }
  const beforeParam = url.searchParams.get('before');
  let before: Date | undefined;
  if (beforeParam !== null) {
    before = new Date(beforeParam);
    if (Number.isNaN(before.getTime())) {
      return botError(400, 'invalid_request', 'before must be an ISO-8601 date', { issues: ['before'] });
    }
  }

  const result = await readMessagesForBot(bot, channelId, { limit, ...(before ? { before } : {}) });
  if (!result.ok) return botError(result.status, result.code, result.error, result.extra);
  return NextResponse.json({ messages: result.value });
}

/**
 * POST /api/bot/v1/channels/{channelId}/messages  { "content": "…" }
 * Post as the bot. Needs `send_messages`. Stored and fanned out like a
 * member's message, marked as the bot's.
 */
async function handlePost(req: Request, ctx: RouteContext, bot: BotRow): Promise<NextResponse> {
  const channelId = await channelIdFrom(ctx);
  if (!channelId) return botError(404, 'not_found', 'Channel not found, or not available to bots');

  const json = await readJsonBody(req);
  if (!json.ok) return json.response;
  const parsed = PostMessageSchema.safeParse(json.body);
  if (!parsed.success) {
    return botError(400, 'invalid_request', 'Invalid request body', { issues: issuesOf(parsed.error) });
  }

  const result = await postBotMessage({ bot, channelId, content: parsed.data.content });
  if (!result.ok) return botError(result.status, result.code, result.error, result.extra);
  return NextResponse.json({ message: toBotApiMessage(result.value, new Map()) }, { status: 201 });
}

export const GET = botApiRoute(
  withMachineApiSecurity(
    withBotAuth(handleGet),
    botApiOptions(['GET'], 'messages-read', { windowMs: 60_000, maxRequests: 60 })
  )
);

export const POST = botApiRoute(
  withMachineApiSecurity(
    withBotAuth(handlePost),
    botApiOptions(['POST'], 'messages-create', { windowMs: 60_000, maxRequests: 30 }, 16 * 1024)
  )
);
