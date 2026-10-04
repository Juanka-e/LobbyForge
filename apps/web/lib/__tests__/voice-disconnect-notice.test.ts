/**
 * What a member sees when LiveKit ends their voice connection. A
 * moderator's "Disconnect from voice" arrives as PARTICIPANT_REMOVED and
 * must read as a plain removal — not as the anti-cheat block, which only
 * the token route reports, on the next join.
 */
import { DisconnectReason } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { translatorFor } from '@/lib/i18n/catalogue';
import { disconnectReasonNotice } from '@/lib/voice-disconnect-notice';

describe('disconnectReasonNotice', () => {
  it('PARTICIPANT_REMOVED (a moderator disconnect, kick or ban) says "removed" in both languages', () => {
    const notice = disconnectReasonNotice(DisconnectReason.PARTICIPANT_REMOVED);
    expect(notice).toEqual({ key: 'lobby.voice.error.removed' });
    expect(translatorFor('en')(notice!.key)).toBe('You were removed from the voice channel.');
    expect(translatorFor('tr')(notice!.key)).toBe('Sesli kanaldan çıkarıldın.');
  });

  it('never claims a block: that message belongs to a refused join', () => {
    const removed = translatorFor('en')(disconnectReasonNotice(DisconnectReason.PARTICIPANT_REMOVED)!.key);
    expect(removed).not.toMatch(/again in|minute/i);
  });

  it('maps the other reasons the lobby explains, and nothing for a normal leave', () => {
    expect(disconnectReasonNotice(DisconnectReason.DUPLICATE_IDENTITY)).toEqual({ key: 'lobby.voice.error.duplicateSession' });
    expect(disconnectReasonNotice(DisconnectReason.ROOM_DELETED)).toEqual({ key: 'lobby.voice.error.roomClosed' });
    expect(disconnectReasonNotice(DisconnectReason.SERVER_SHUTDOWN)).toEqual({ key: 'lobby.voice.error.serverRestarted' });
    expect(disconnectReasonNotice(DisconnectReason.CLIENT_INITIATED)).toBeNull();
    expect(disconnectReasonNotice(undefined)).toBeNull();
  });
});
