import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { BotRow } from '@lobbyforge/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, readJsonBody, withBotAuth } from '@/lib/bots/api';
import { answerInteraction } from '@/lib/bots/interactions';
import { AnswerSchema, V2_ANSWER_LIMIT, V2_ANSWER_LIMIT_ID, failureResponse, invalidRequest } from '../../../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/bot/v2/interactions/{id}/respond  { content, ephemeral? }
 * Answer an interaction — once (409 after), within 15 minutes (410).
 * Needs `slash_commands`, plus `send_messages` unless ephemeral. Another
 * bot's interaction id is 404.
 */
async function handlePost(req: Request, ctx: RouteContext, bot: BotRow): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return botError(404, 'not_found', 'Interaction not found');
  const json = await readJsonBody(req);
  if (!json.ok) return json.response;
  const parsed = AnswerSchema.safeParse(json.body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const result = await answerInteraction({
    bot,
    interactionId: id,
    content: parsed.data.content,
    ephemeral: parsed.data.ephemeral ?? false,
    kind: 'respond',
  });
  if (!result.ok) return failureResponse(result);
  return NextResponse.json(result.value);
}

export const POST = botApiRoute(
  withMachineApiSecurity(withBotAuth(handlePost), botApiOptions(['POST'], V2_ANSWER_LIMIT_ID, V2_ANSWER_LIMIT, 16 * 1024))
);
