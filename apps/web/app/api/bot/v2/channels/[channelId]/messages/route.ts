/**
 * GET / POST /api/bot/v2/channels/{channelId}/messages — read and post.
 * Same handlers as v1 (which honour per-bot channel access, §1.1); a
 * message object may additionally carry `webhook` or `interaction`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export { GET, POST } from '../../../../v1/channels/[channelId]/messages/route';
