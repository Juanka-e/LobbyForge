/**
 * The client-safe half of the voice block (lib/voice-block.ts): the error
 * code `/api/livekit/token` answers with while a member is blocked, and
 * the notice the lobby shows for it.
 *
 * Kept apart from voice-block.ts on purpose: that module talks to Redis
 * (ioredis), and the browser bundle must not pull it in.
 */

/** `code` of the token route's 403 while the member is blocked from voice on that server. */
export const VOICE_BLOCKED_CODE = 'voice_blocked';

export interface VoiceBlockedNotice {
  key: 'lobby.voice.error.voiceBlocked';
  params: { minutes: number };
}

/**
 * The lobby notice for a token-route error body, or null when the body is
 * not a voice block. The server's English `error` text is not shown for
 * this code: the catalogue says the same thing in the viewer's language,
 * with how long is left (`retryAfter` seconds, rounded UP to whole
 * minutes so "0 minutes" never appears while the block still holds).
 */
export function voiceBlockedNotice(body: unknown): VoiceBlockedNotice | null {
  if (!body || typeof body !== 'object') return null;
  const { code, retryAfter } = body as { code?: unknown; retryAfter?: unknown };
  if (code !== VOICE_BLOCKED_CODE) return null;
  const seconds = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
  return { key: 'lobby.voice.error.voiceBlocked', params: { minutes: Math.max(1, Math.ceil(seconds / 60)) } };
}
