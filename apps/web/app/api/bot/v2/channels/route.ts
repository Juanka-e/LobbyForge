/**
 * GET /api/bot/v2/channels — the channels this bot reaches. Same handler
 * as v1, which already honours per-bot channel access (§1.1).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export { GET } from '../../v1/channels/route';
