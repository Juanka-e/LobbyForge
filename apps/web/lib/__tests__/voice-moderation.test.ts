import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  listChannelsForServer: vi.fn(),
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getEffectiveServerVoiceSettings: vi.fn(),
  getActiveMemberTimeout: vi.fn(),
  isMemberVoiceMuted: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('../db', () => ({ getDb: () => ({ __db: true }) }));

const lk = {
  listParticipants: vi.fn(),
  getParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  updateParticipant: vi.fn(),
  mutePublishedTrack: vi.fn(),
};
vi.mock('../livekit', () => ({ getRoomServiceClient: () => lk }));
vi.mock('../livekit-room', () => ({ liveKitRoomName: (s: string, c: string) => `room-${s}-${c}` }));
const authorizeChannelVisibility = vi.fn();
vi.mock('../permissions', () => ({ authorizeChannelVisibility: (...a: unknown[]) => authorizeChannelVisibility(...a) }));
vi.mock('livekit-server-sdk', () => ({
  TrackSource: { UNKNOWN: 0, CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 },
}));

const SERVER = 'srv';
const USER = 'usr';

beforeEach(() => {
  vi.resetModules();
  for (const fn of [...Object.values(db), ...Object.values(lk), authorizeChannelVisibility]) fn.mockReset();
  db.listChannelsForServer.mockResolvedValue([
    { id: 'voice1', type: 'voice' },
    { id: 'text1', type: 'text' },
  ]);
  db.getServerById.mockResolvedValue({ ownerUserId: 'owner' });
  db.isServerMember.mockResolvedValue(true);
  db.getUserPermissions.mockResolvedValue(['connect_voice', 'speak', 'stream']);
  db.getEffectiveServerVoiceSettings.mockResolvedValue({ allowCamera: true, allowScreenShare: false });
  db.getActiveMemberTimeout.mockResolvedValue(null);
  db.isMemberVoiceMuted.mockResolvedValue(false);
  authorizeChannelVisibility.mockResolvedValue({ ok: true });
  lk.getParticipant.mockResolvedValue({
    permission: { canSubscribe: true, canPublish: true, canPublishData: true, canPublishSources: [2, 1] },
    tracks: [
      { sid: 'cam', source: 1, muted: false },
      { sid: 'mic', source: 2, muted: false },
    ],
  });
});

async function load() {
  return import('../voice-moderation');
}

describe('buildAllowedPublishSources', () => {
  it('drops the microphone for a server-muted or timed-out member', async () => {
    const { buildAllowedPublishSources } = await load();
    const base = { allowCamera: true, allowScreenShare: true, memberPermissions: ['speak', 'stream'] };
    expect(buildAllowedPublishSources({ ...base, timedOut: false, voiceMuted: false })).toContain('microphone');
    expect(buildAllowedPublishSources({ ...base, timedOut: false, voiceMuted: true })).not.toContain('microphone');
    expect(buildAllowedPublishSources({ ...base, timedOut: true, voiceMuted: false })).not.toContain('microphone');
  });

  // security-review AUTHZ-006: a muted member kept talking through
  // screen-share audio; a timed-out member could still broadcast video.
  it('server mute also drops screen-share audio, but keeps camera and silent screen share', async () => {
    const { buildAllowedPublishSources } = await load();
    const base = { allowCamera: true, allowScreenShare: true, memberPermissions: ['speak', 'stream'] };
    expect(buildAllowedPublishSources({ ...base, timedOut: false, voiceMuted: false })).toEqual([
      'microphone',
      'camera',
      'screen-share',
      'screen-share-audio',
    ]);
    expect(buildAllowedPublishSources({ ...base, timedOut: false, voiceMuted: true })).toEqual(['camera', 'screen-share']);
  });

  it('a timeout allows no source at all (listen-only), whatever the client asks for', async () => {
    const { buildAllowedPublishSources, canPublishAnySource } = await load();
    const base = { allowCamera: true, allowScreenShare: true, memberPermissions: ['speak', 'stream'] };
    const sources = buildAllowedPublishSources({ ...base, timedOut: true, voiceMuted: false }, [
      'microphone',
      'camera',
      'screen-share',
      'screen-share-audio',
    ]);
    expect(sources).toEqual([]);
    // LiveKit reads [] as "no restriction" — the grant must be canPublish:false.
    expect(canPublishAnySource(sources)).toBe(false);
    expect(canPublishAnySource(['camera'])).toBe(true);
  });
});

describe('syncMemberVoiceAccess', () => {
  it('server mute: mutes the MICROPHONE track (not the camera) and revokes the mic grant live', async () => {
    db.isMemberVoiceMuted.mockResolvedValue(true);
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.getParticipant).toHaveBeenCalledTimes(1); // voice channels only
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith('room-srv-voice1', USER, 'mic', true);
    expect(lk.updateParticipant).toHaveBeenCalledWith(
      'room-srv-voice1',
      USER,
      expect.objectContaining({
        permission: expect.objectContaining({ canPublishSources: [1] }), // camera only
      })
    );
    expect(lk.removeParticipant).not.toHaveBeenCalled();
  });

  it('server mute (security-review AUTHZ-006): also mutes a live screen-share AUDIO track, not the screen video', async () => {
    db.isMemberVoiceMuted.mockResolvedValue(true);
    db.getEffectiveServerVoiceSettings.mockResolvedValue({ allowCamera: true, allowScreenShare: true });
    lk.getParticipant.mockResolvedValue({
      permission: { canSubscribe: true, canPublish: true, canPublishData: true, canPublishSources: [2, 1, 3, 4] },
      tracks: [
        { sid: 'mic', source: 2, muted: false },
        { sid: 'screen', source: 3, muted: false },
        { sid: 'screen-audio', source: 4, muted: false },
      ],
    });
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith('room-srv-voice1', USER, 'mic', true);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith('room-srv-voice1', USER, 'screen-audio', true);
    expect(lk.mutePublishedTrack).not.toHaveBeenCalledWith('room-srv-voice1', USER, 'screen', true);
    expect(lk.updateParticipant).toHaveBeenCalledWith(
      'room-srv-voice1',
      USER,
      expect.objectContaining({
        permission: expect.objectContaining({ canPublish: true, canPublishSources: [1, 3] }), // camera + screen
      })
    );
  });

  it('timeout (security-review AUTHZ-006): silences every live track and grants canPublish:false', async () => {
    db.getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith('room-srv-voice1', USER, 'mic', true);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith('room-srv-voice1', USER, 'cam', true);
    expect(lk.updateParticipant).toHaveBeenCalledWith(
      'room-srv-voice1',
      USER,
      expect.objectContaining({
        // Never canPublish:true with [] — LiveKit would read it as "anything".
        permission: expect.objectContaining({ canPublish: false, canSubscribe: true, canPublishSources: [] }),
      })
    );
    expect(lk.removeParticipant).not.toHaveBeenCalled();
  });

  it('unmute: re-allows the microphone WITHOUT unmuting the track remotely', async () => {
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.mutePublishedTrack).not.toHaveBeenCalled();
    expect(lk.updateParticipant).toHaveBeenCalledWith(
      'room-srv-voice1',
      USER,
      expect.objectContaining({ permission: expect.objectContaining({ canPublishSources: [2, 1] }) })
    );
  });

  it('removes a user who is no longer a member (kick / ban) from the room', async () => {
    db.isServerMember.mockResolvedValue(false);
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.removeParticipant).toHaveBeenCalledWith('room-srv-voice1', USER);
    expect(lk.updateParticipant).not.toHaveBeenCalled();
  });

  it('removes a member who can no longer see the channel', async () => {
    authorizeChannelVisibility.mockResolvedValue({ ok: false });
    const { syncMemberVoiceAccess } = await load();
    await syncMemberVoiceAccess(SERVER, USER);
    expect(lk.removeParticipant).toHaveBeenCalledWith('room-srv-voice1', USER);
  });

  it('is a no-op when the member is not connected', async () => {
    lk.getParticipant.mockRejectedValue(Object.assign(new Error('participant not found'), { status: 404 }));
    const { syncMemberVoiceAccess } = await load();
    await expect(syncMemberVoiceAccess(SERVER, USER)).resolves.toBeUndefined();
    expect(lk.updateParticipant).not.toHaveBeenCalled();
    expect(lk.removeParticipant).not.toHaveBeenCalled();
  });
});

describe('syncServerVoiceAccess', () => {
  it('re-syncs every participant connected to the (selected) voice rooms once', async () => {
    db.listChannelsForServer.mockResolvedValue([
      { id: 'voice1', type: 'voice' },
      { id: 'voice2', type: 'voice' },
    ]);
    lk.listParticipants.mockImplementation(async (room: string) =>
      room === 'room-srv-voice1' ? [{ identity: 'a' }, { identity: 'b' }] : [{ identity: 'a' }]
    );
    db.isServerMember.mockResolvedValue(false); // e.g. role removal took CONNECT_VOICE away
    const { syncServerVoiceAccess } = await load();
    await syncServerVoiceAccess(SERVER, ['voice1']);
    expect(lk.listParticipants).toHaveBeenCalledTimes(1);
    expect(lk.removeParticipant).toHaveBeenCalledWith('room-srv-voice1', 'a');
    expect(lk.removeParticipant).toHaveBeenCalledWith('room-srv-voice1', 'b');
  });
});
