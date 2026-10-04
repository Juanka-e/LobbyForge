/**
 * GET /api/bot/v2/me — who this token belongs to. Identical to v1
 * (docs/BOT_API_V2.md §3.2); the v1 handler, budget included, is reused.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export { GET } from '../../v1/me/route';
