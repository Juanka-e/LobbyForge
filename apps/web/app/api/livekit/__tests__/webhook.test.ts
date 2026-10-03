/**
 * security-review AUTHZ-006 follow-up: the LiveKit webhook removes a
 * participant who publishes a track whose KIND does not match its SOURCE
 * (a server-muted member's microphone published as `camera`, video as
 * `microphone`, …), blocks them from voice on that server, and removes a
 * blocked identity again on `participant_joined` (a token minted before
 * the block, still valid). Requests are signed by LiveKit — the real
 * livekit-server-sdk signs and verifies here, nothing about the signature
 * check is mocked.
 */
import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const API_KEY = 'devkey_test';
const API_SECRET = 'webhook-test-secret-0123456789abcdef';

const removeParticipant = vi.fn();
const listRooms = vi.fn();
const logAction = vi.fn();
const blockVoice = vi.fn();
const isVoiceBlocked = vi.fn();

vi.mock('@/lib/livekit', () => ({
  requireLiveKitCredentials: () => ({ apiKey: API_KEY, apiSecret: API_SECRET }),
  getRoomServiceClient: () => ({ removeParticipant, listRooms }),
}));
vi.mock('@lobbyforge/db', () => ({ logAction }));
// The block list's own behaviour (keys, ladder) is covered in
// lib/__tests__/voice-block.test.ts; here only how the webhook uses it.
vi.mock('@/lib/voice-block', () => ({ blockVoice, isVoiceBlocked }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withMachineApiSecurity: (handler: unknown) => handler,
}));

const SERVER_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const CHANNEL_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const ROOM = `s_${SERVER_ID.replaceAll('-', '')}_c_${CHANNEL_ID.replaceAll('-', '')}`;
const IDENTITY = '0a1b2c3d-0000-4000-8000-0000000000aa';

/** A track as LiveKit's protojson writes it (zero values — AUDIO, UNKNOWN — omitted). */
function trackJson(type: 'AUDIO' | 'VIDEO', source: string, sid = 'TR_new') {
  return {
    sid,
    ...(type === 'VIDEO' ? { type } : {}),
    ...(source !== 'UNKNOWN' ? { source } : {}),
    mimeType: type === 'VIDEO' ? 'video/VP8' : 'audio/opus',
  };
}

function trackPublished(track: Record<string, unknown>, otherTracks: Array<Record<string, unknown>> = [], room = ROOM) {
  return JSON.stringify({
    event: 'track_published',
    id: 'EV_1',
    createdAt: '1790000000',
    room: { sid: 'RM_1', name: room },
    participant: { sid: 'PA_1', identity: IDENTITY, name: 'Muted', tracks: [track, ...otherTracks] },
    track,
  });
}

async function sign(body: string, key = API_KEY, secret = API_SECRET): Promise<string> {
  const token = new AccessToken(key, secret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

async function post(body: string, authorization?: string): Promise<Response> {
  const { POST } = await import('../webhook/route');
  return POST(
    new Request('http://web:3000/api/livekit/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/webhook+json',
        ...(authorization !== undefined ? { authorization } : {}),
      },
      body,
    }),
    {}
  );
}

async function signedPost(body: string): Promise<Response> {
  return post(body, await sign(body));
}

beforeEach(() => {
  removeParticipant.mockReset().mockResolvedValue(undefined);
  listRooms.mockReset().mockResolvedValue([]);
  logAction.mockReset().mockResolvedValue(undefined);
  blockVoice.mockReset().mockResolvedValue({ serverId: SERVER_ID, strike: 1, seconds: 600 });
  isVoiceBlocked.mockReset().mockResolvedValue(false);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/livekit/webhook — authentication', () => {
  const body = trackPublished(trackJson('AUDIO', 'CAMERA'));

  it('refuses a request without the LiveKit Authorization header', async () => {
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('refuses a token signed with another secret', async () => {
    const res = await post(body, await sign(body, API_KEY, 'not-the-livekit-secret-0123456789'));
    expect(res.status).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('refuses a token issued for another API key', async () => {
    const res = await post(body, await sign(body, 'other_key', API_SECRET));
    expect(res.status).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('refuses a valid token for a DIFFERENT body (sha256 mismatch)', async () => {
    const harmless = trackPublished(trackJson('VIDEO', 'CAMERA'));
    const res = await post(body, await sign(harmless));
    expect(res.status).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('refuses garbage', async () => {
    expect((await post(body, 'not-a-jwt')).status).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });
});

describe('POST /api/livekit/webhook — track_published', () => {
  it.each([
    ['audio published as camera', trackJson('AUDIO', 'CAMERA'), 'camera', 'audio'],
    ['audio published as screen share', trackJson('AUDIO', 'SCREEN_SHARE'), 'screen_share', 'audio'],
    ['video published as microphone', trackJson('VIDEO', 'MICROPHONE'), 'microphone', 'video'],
    ['video published as screen-share audio', trackJson('VIDEO', 'SCREEN_SHARE_AUDIO'), 'screen_share_audio', 'video'],
    ['audio with no source', trackJson('AUDIO', 'UNKNOWN'), 'unknown', 'audio'],
  ])('removes the participant: %s', async (_label, track, source, type) => {
    const res = await signedPost(trackPublished(track));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(removeParticipant).toHaveBeenCalledTimes(1);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('removing a participant'),
      expect.objectContaining({ room: ROOM, identity: IDENTITY, source, type, blockedSeconds: 600 })
    );
    expect(logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({
        serverId: SERVER_ID,
        actorUserId: null,
        action: 'voice.track_rejected',
        targetType: 'user',
        targetId: IDENTITY,
        metadata: { channelId: CHANNEL_ID, room: ROOM, source, type, blockedSeconds: 600 },
      })
    );
  });

  it('also removes them from every other live room of the SAME server, and only that server', async () => {
    const otherChannel = '0a1b2c3d-0000-4000-8000-000000000003';
    const otherServer = '0a1b2c3d-0000-4000-8000-000000000009';
    const sameServerRoom = `s_${SERVER_ID.replaceAll('-', '')}_c_${otherChannel.replaceAll('-', '')}`;
    const otherServerRoom = `s_${otherServer.replaceAll('-', '')}_c_${CHANNEL_ID.replaceAll('-', '')}`;
    listRooms.mockResolvedValue([{ name: ROOM }, { name: sameServerRoom }, { name: otherServerRoom }, { name: 'not-ours' }]);
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(200);
    const rooms = removeParticipant.mock.calls.map((call) => call[0]);
    expect(rooms).toEqual([ROOM, sameServerRoom]);
  });

  it('a failing room listing does not undo the removal from the offending room', async () => {
    listRooms.mockRejectedValue(new Error('livekit down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
  });

  it('also blocks the participant from voice on that server, keyed to this connection, BEFORE removing them', async () => {
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(200);
    expect(blockVoice).toHaveBeenCalledTimes(1);
    expect(blockVoice).toHaveBeenCalledWith({ serverId: SERVER_ID, channelId: CHANNEL_ID }, IDENTITY, { offenceId: 'PA_1' });
    // The token route must already refuse when the removed client reconnects.
    expect(blockVoice.mock.invocationCallOrder[0]).toBeLessThan(removeParticipant.mock.invocationCallOrder[0]!);
  });

  it('still removes (and audits, without a block length) when the block cannot be recorded', async () => {
    blockVoice.mockRejectedValueOnce(new Error('redis down'));
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not record the voice block'), 'redis down');
    expect(logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ metadata: { channelId: CHANNEL_ID, room: ROOM, source: 'camera', type: 'audio' } })
    );
  });

  it('removes the participant when the negotiated mime type contradicts the declared type', async () => {
    const res = await signedPost(trackPublished({ sid: 'TR_x', type: 'VIDEO', source: 'CAMERA', mimeType: 'audio/opus' }));
    expect(res.status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
  });

  it.each([
    ['microphone audio', trackJson('AUDIO', 'MICROPHONE')],
    ['screen-share audio', trackJson('AUDIO', 'SCREEN_SHARE_AUDIO')],
    ['camera video', trackJson('VIDEO', 'CAMERA')],
    ['screen-share video', trackJson('VIDEO', 'SCREEN_SHARE')],
  ])('leaves a normal track alone: %s', async (_label, track) => {
    const res = await signedPost(trackPublished(track, [trackJson('AUDIO', 'MICROPHONE', 'TR_mic')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(removeParticipant).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
    expect(blockVoice).not.toHaveBeenCalled();
  });

  it('also catches a mislabelled track already on the participant (an earlier event that never arrived)', async () => {
    const res = await signedPost(trackPublished(trackJson('VIDEO', 'CAMERA'), [trackJson('AUDIO', 'SCREEN_SHARE', 'TR_old')]));
    expect(res.status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
  });

  it('treats a participant who already left as done (404 from RoomService)', async () => {
    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('participant not found'), { status: 404, code: 'not_found' }));
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(200);
  });

  it('answers 503 when LiveKit cannot be reached, so the delivery is retried', async () => {
    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { status: 0 }));
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')));
    expect(res.status).toBe(503);
    expect(logAction).not.toHaveBeenCalled();
  });

  it('still removes when the audit write fails, and skips the audit for a room name the app did not mint', async () => {
    logAction.mockRejectedValueOnce(new Error('db down'));
    expect((await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA')))).status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledTimes(1);

    logAction.mockClear();
    blockVoice.mockClear();
    const res = await signedPost(trackPublished(trackJson('AUDIO', 'CAMERA'), [], 'some-other-room'));
    expect(res.status).toBe(200);
    expect(removeParticipant).toHaveBeenLastCalledWith('some-other-room', IDENTITY);
    expect(logAction).not.toHaveBeenCalled();
    // No server to scope a block to — removal only.
    expect(blockVoice).not.toHaveBeenCalled();
  });
});

describe('POST /api/livekit/webhook — participant_joined', () => {
  function participantJoined(room = ROOM, identity = IDENTITY) {
    return JSON.stringify({
      event: 'participant_joined',
      id: 'EV_3',
      room: { sid: 'RM_1', name: room },
      participant: { sid: 'PA_2', identity, tracks: [] },
    });
  }

  it('removes a participant who joins while blocked (a token minted before the block), with a log line and no audit row', async () => {
    isVoiceBlocked.mockResolvedValueOnce(true);
    const res = await signedPost(participantJoined());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(isVoiceBlocked).toHaveBeenCalledWith({ serverId: SERVER_ID, channelId: CHANNEL_ID }, IDENTITY);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, IDENTITY);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('joined while blocked'),
      expect.objectContaining({ room: ROOM, identity: IDENTITY })
    );
    expect(logAction).not.toHaveBeenCalled();
    // Re-removal is not a new offence: the block is not lengthened.
    expect(blockVoice).not.toHaveBeenCalled();
  });

  it('does nothing for a participant who is not blocked', async () => {
    const res = await signedPost(participantJoined());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(isVoiceBlocked).toHaveBeenCalledTimes(1);
    expect(removeParticipant).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('skips the check for a room name the app did not mint', async () => {
    const res = await signedPost(participantJoined('some-other-room'));
    expect(res.status).toBe(200);
    expect(isVoiceBlocked).not.toHaveBeenCalled();
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('fails open with a 200 (no retry storm) when the block list cannot be read', async () => {
    isVoiceBlocked.mockRejectedValueOnce(new Error('redis down'));
    const res = await signedPost(participantJoined());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(removeParticipant).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('voice block check failed'), 'redis down');
  });

  it('treats a participant already gone as done, and asks for a retry when LiveKit cannot be reached', async () => {
    isVoiceBlocked.mockResolvedValue(true);
    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('participant not found'), { status: 404 }));
    expect((await signedPost(participantJoined())).status).toBe(200);

    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { status: 0 }));
    expect((await signedPost(participantJoined())).status).toBe(503);
  });
});

describe('POST /api/livekit/webhook — other events', () => {
  it.each(['participant_left', 'room_started', 'room_finished', 'track_unpublished'])(
    'acknowledges %s and does nothing',
    async (name) => {
      // Even for a blocked identity: only participant_joined acts on the block.
      isVoiceBlocked.mockResolvedValue(true);
      const body = JSON.stringify({
        event: name,
        id: 'EV_2',
        room: { sid: 'RM_1', name: ROOM },
        participant: { sid: 'PA_1', identity: IDENTITY, tracks: [trackJson('AUDIO', 'CAMERA')] },
        track: trackJson('AUDIO', 'CAMERA'),
      });
      const res = await signedPost(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(removeParticipant).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
      expect(blockVoice).not.toHaveBeenCalled();
      expect(isVoiceBlocked).not.toHaveBeenCalled();
    }
  );
});
