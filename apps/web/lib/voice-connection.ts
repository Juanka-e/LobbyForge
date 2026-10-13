/**
 * What LiveKit's connection state means for the lobby.
 *
 * A dropped network makes LiveKit resume the signal connection first
 * (`SignalReconnecting` — the media path may still be up) and fall back to
 * a full `Reconnecting` only when that fails. Either way the person is
 * still in the room, for up to two minutes (lib/voice-resume.ts): the
 * footer says "Reconnecting...", and nothing should treat them as gone —
 * not the activity view's "Join the voice channel" bar, not the full-screen
 * voice view.
 */
import { ConnectionState } from 'livekit-client';

/** LiveKit is resuming a dropped connection (signal first, then full). */
export function isVoiceReconnecting(state: ConnectionState | null | undefined): boolean {
  return state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
}

/** Still in the voice room: connected, or LiveKit reconnecting. */
export function isInVoiceRoom(state: ConnectionState | null | undefined): boolean {
  return state === ConnectionState.Connected || isVoiceReconnecting(state);
}
