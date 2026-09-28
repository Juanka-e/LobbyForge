/**
 * The Bot API v1 request pipeline (`/api/bot/v1/*`).
 *
 * Token-authenticated, never cookie-authenticated: the only credential is
 * `Authorization: Bot <token>`, so a browser page cannot ride a member's
 * session into it (CSRF does not apply — and without CORS headers a
 * cross-origin page cannot even send that header). So every route sits
 * behind the shared MACHINE boundary, `withMachineApiSecurity` (method
 * allowlist, bounded body, maintenance mode, rate limit, security headers,
 * no Origin guard — a server-side bot sends no Origin), and brings its own
 * authentication, as that wrapper's contract requires:
 *
 *   export const POST = botApiRoute(
 *     withMachineApiSecurity(withBotAuth(handlePost), botApiOptions(['POST'], 'messages-create', LIMIT))
 *   );
 *
 *   1. `botRateScope` (run by the boundary before its rate limit):
 *      parse `lfb_<id>_<secret>` — no token, no database work; a
 *      well-formed one first counts against a generous per-address cap,
 *      then loads that one bot (only while its server exists) and compares
 *      the token hash in constant time. The verdict is kept for the
 *      handler, so a request costs one lookup. An authenticated bot is
 *      rate limited on its OWN per-endpoint budget; anyone else on the
 *      caller's address — nobody can spend a bot's budget without its token.
 *   2. `withBotAuth`: 401 (then 429 after too many failures from one
 *      address) or 403 for a disabled bot; otherwise the handler runs with
 *      the bot. Only `custom` bots authenticate — built-ins have no token.
 *   3. `botApiRoute`: every error is `{ error, code, ...details }` — the
 *      boundary's own 405/413/429/503 get their `code` here — and nothing
 *      is cached.
 */
import { NextResponse } from 'next/server';
import { getActiveBotById, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import {
  distributedRateLimit,
  resolveClientAddress,
  type RateLimitConfig,
  type RateLimitResult,
} from '@/lib/security-headers';
import { noteBotActivity } from './activity';
import { CUSTOM_BOT_TYPE } from './catalog';
import { hashBotToken, parseBotToken, readBotAuthorization, verifyBotToken } from './token';

/** Every request that presents a well-formed token, per address, before the lookup. */
export const BOT_API_ADDRESS_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 600 };
/** Failed authentication, per client address, across all endpoints. */
export const BOT_API_UNAUTHENTICATED_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 30 };
/** Compared against when the claimed bot has no token, so every path hashes + compares. */
const ABSENT_BOT_HASH = hashBotToken('lfb_absent');

export function botError(
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status, headers });
}

function rateLimited(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return botError(
    429,
    'rate_limited',
    'Rate limit exceeded',
    { retryAfter, resetAt: new Date(result.resetAt).toISOString() },
    { 'Retry-After': String(retryAfter), 'X-RateLimit-Reset': new Date(result.resetAt).toISOString() }
  );
}

type AuthVerdict =
  | { kind: 'bot'; bot: BotRow }
  | { kind: 'unauthenticated'; presented: boolean }
  | { kind: 'address_limited'; result: RateLimitResult };

/** Verdicts from `botRateScope`, for `withBotAuth` on the same request. */
const verdicts = new WeakMap<Request, AuthVerdict>();

async function authenticate(req: Request): Promise<AuthVerdict> {
  const token = readBotAuthorization(req.headers.get('authorization'));
  const claimed = token ? parseBotToken(token) : null;
  if (!token || !claimed) return { kind: 'unauthenticated', presented: token !== null };

  const perAddress = await distributedRateLimit(`bot-api-addr:${resolveClientAddress(req)}`, BOT_API_ADDRESS_LIMIT);
  if (!perAddress.allowed) return { kind: 'address_limited', result: perAddress };

  const bot = await getActiveBotById(getDb(), claimed.botId);
  const matches = verifyBotToken(token, bot?.tokenHash ?? ABSENT_BOT_HASH);
  if (bot && matches && bot.tokenHash && bot.type === CUSTOM_BOT_TYPE) return { kind: 'bot', bot };
  return { kind: 'unauthenticated', presented: true };
}

/**
 * `rateScope` for `withMachineApiSecurity`: the authenticated bot, so its
 * budget is its own; `null` (the caller's address) for everyone else.
 */
export async function botRateScope(req: Request): Promise<string | null> {
  const verdict = await authenticate(req);
  verdicts.set(req, verdict);
  return verdict.kind === 'bot' ? `bot:${verdict.bot.id}` : null;
}

/** The boundary options every Bot API route uses. */
export function botApiOptions(
  allowedMethods: string[],
  identifier: string,
  config: RateLimitConfig,
  maxBodyBytes = 1024
) {
  return {
    allowedMethods,
    rateLimit: { identifier: `bot-api-${identifier}`, config },
    rateScope: botRateScope,
    maxBodyBytes,
  };
}

/** Resolve the bot for a request that passed the boundary, or answer for it. */
export function withBotAuth<TContext = unknown>(
  handler: (req: Request, ctx: TContext, bot: BotRow) => Promise<NextResponse>
) {
  return async (req: Request, ctx: TContext): Promise<NextResponse> => {
    const verdict = verdicts.get(req) ?? (await authenticate(req));
    verdicts.delete(req);
    if (verdict.kind === 'address_limited') return rateLimited(verdict.result);
    if (verdict.kind === 'unauthenticated') {
      const gate = await distributedRateLimit(
        `bot-api-unauth:${resolveClientAddress(req)}`,
        BOT_API_UNAUTHENTICATED_LIMIT
      );
      if (!gate.allowed) return rateLimited(gate);
      return botError(
        401,
        'unauthorized',
        verdict.presented ? 'Invalid bot token' : 'Missing bot token: send "Authorization: Bot <token>"',
        {},
        { 'WWW-Authenticate': 'Bot' }
      );
    }
    const { bot } = verdict;
    if (!bot.enabled) return botError(403, 'bot_disabled', 'This bot is disabled');
    noteBotActivity(bot.id);
    try {
      return await handler(req, ctx, bot);
    } catch (err) {
      console.error('[bot-api] request failed:', (err as Error).message);
      return botError(500, 'internal_error', 'Internal error');
    }
  };
}

/** The `code` for an error the shared boundary produced itself. */
function boundaryCode(status: number, body: Record<string, unknown>): string {
  if (status === 405) return 'method_not_allowed';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 503) return body.error === 'Maintenance mode' ? 'maintenance' : 'unavailable';
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

/**
 * The outermost layer of every Bot API route: `Cache-Control: no-store`
 * on everything, and a `code` on every error — including the ones the
 * shared boundary answers before a bot handler runs.
 */
export function botApiRoute<TContext = unknown>(route: (req: Request, ctx: TContext) => Promise<Response>) {
  return async (req: Request, ctx: TContext): Promise<NextResponse> => {
    const response = await route(req, ctx);
    let out: NextResponse;
    if (response.status >= 400 && response.headers.get('content-type')?.includes('application/json')) {
      const body = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null;
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.code !== 'string') {
        out = NextResponse.json({ ...body, code: boundaryCode(response.status, body) }, { status: response.status });
        response.headers.forEach((value, key) => {
          if (key !== 'content-length' && key !== 'content-type') out.headers.set(key, value);
        });
      } else {
        out = response instanceof NextResponse ? response : new NextResponse(response.body, response);
      }
    } else {
      out = response instanceof NextResponse ? response : new NextResponse(response.body, response);
    }
    out.headers.set('Cache-Control', 'no-store');
    return out;
  };
}

/** Read a JSON body, or say why not. */
export async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: botError(400, 'invalid_request', 'Body must be JSON') };
  }
}
