/**
 * Pieces every Bot API v2 route shares (not a route itself). The request
 * pipeline is v1's (`lib/bots/api.ts`: machine boundary, bot-token auth,
 * per-bot rate limits, `{ error, code }` errors); this adds the v2
 * permission gate and the limits from docs/BOT_API_V2.md §3.2.
 */
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import type { BotRow } from '@lobbyforge/db';
import type { RateLimitConfig } from '@/lib/security-headers';
import { botError } from '@/lib/bots/api';
import { MAX_BOT_MESSAGE_LENGTH } from '@/lib/bots/catalog';
import { botHasPermission, type BotPermissionId } from '@/lib/bots/permissions';
import type { BotFailure } from '@/lib/bots/messages';

/** `respond` / `followup` body: `{ content (1..4000), ephemeral? }`, nothing else. */
export const AnswerSchema = z
  .object({
    content: z
      .string()
      .refine((value) => value.trim().length > 0, 'content must not be empty')
      .refine((value) => value.length <= MAX_BOT_MESSAGE_LENGTH, `content must be at most ${MAX_BOT_MESSAGE_LENGTH} characters`),
    ephemeral: z.boolean().optional(),
  })
  .strict();

/** Reads and small writes: 60 per minute per bot, each endpoint. */
export const V2_READ_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 60 };
/** `PUT /commands`: 5 per minute per bot. */
export const V2_COMMANDS_PUT_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 5 };
/** respond + followup together: 60 per minute per bot (one shared budget). */
export const V2_ANSWER_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 60 };
export const V2_ANSWER_LIMIT_ID = 'interactions-answer';
/** Setting / removing the event endpoint (each save re-resolves DNS): 10 per minute. */
export const V2_ENDPOINT_WRITE_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 10 };

/** 403 unless the bot holds the permission. */
export function requireBotPermission(bot: Pick<BotRow, 'permissions'>, permission: BotPermissionId): NextResponse | null {
  if (botHasPermission(bot, permission)) return null;
  return botError(403, 'missing_permission', `This bot lacks the ${permission} permission`, { permission });
}

export function failureResponse(failure: BotFailure): NextResponse {
  return botError(failure.status, failure.code, failure.error, failure.extra);
}

export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
}

export function invalidRequest(error: z.ZodError): NextResponse {
  return botError(400, 'invalid_request', 'Invalid request body', { issues: issuesOf(error) });
}
