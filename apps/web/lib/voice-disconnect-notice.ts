/**
 * What the lobby says when LiveKit ends your voice connection, by reason.
 *
 * PARTICIPANT_REMOVED covers every removal by the server: a moderator's
 * "Disconnect from voice", a kick / ban / lost permission, and the voice
 * anti-cheat. Only the anti-cheat also blocks — and that is reported when
 * the NEXT join is refused (`lobby.voice.error.voiceBlocked`, from the
 * token route), never here: after a plain removal the member may click
 * the channel again straight away.
 */
import { DisconnectReason } from 'livekit-client';

export interface DisconnectNotice {
  key:
    | 'lobby.voice.error.duplicateSession'
    | 'lobby.voice.error.removed'
    | 'lobby.voice.error.roomClosed'
    | 'lobby.voice.error.serverRestarted';
}

export function disconnectReasonNotice(reason: DisconnectReason | undefined): DisconnectNotice | null {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return { key: 'lobby.voice.error.duplicateSession' };
    case DisconnectReason.PARTICIPANT_REMOVED:
      return { key: 'lobby.voice.error.removed' };
    case DisconnectReason.ROOM_DELETED:
      return { key: 'lobby.voice.error.roomClosed' };
    case DisconnectReason.SERVER_SHUTDOWN:
      return { key: 'lobby.voice.error.serverRestarted' };
    default:
      return null;
  }
}
