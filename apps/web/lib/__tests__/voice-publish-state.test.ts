import { describe, expect, it } from 'vitest';
import {
  isMicrophoneBlocked,
  PROTO_SOURCE_MICROPHONE,
  publishBlockAtJoin,
  publishBlockedReason,
  publishBlockFromPermissions,
  resolvePublishBlockReason,
} from '../voice-publish-state';

// livekit-client's protobuf TrackSource values.
const CAMERA = 1;
const MICROPHONE = PROTO_SOURCE_MICROPHONE;
const SCREEN_SHARE = 3;
const SCREEN_SHARE_AUDIO = 4;

// security-review AUTHZ-006 follow-up: the grant for a timed-out member is
// canPublish:false with an EMPTY source list. The old client check ("a
// non-empty list without the mic") read that as a normal speaker.
describe('publishBlockFromPermissions', () => {
  it('a normal member (canPublish with the mic among the sources) is not blocked', () => {
    expect(
      publishBlockFromPermissions({ canPublish: true, canPublishSources: [MICROPHONE, CAMERA, SCREEN_SHARE, SCREEN_SHARE_AUDIO] })
    ).toBe('none');
  });

  it("canPublish with an empty list is LiveKit's \"no restriction\", not a block", () => {
    expect(publishBlockFromPermissions({ canPublish: true, canPublishSources: [] })).toBe('none');
  });

  it('a server-muted member (sources without the mic) has only the microphone blocked', () => {
    expect(publishBlockFromPermissions({ canPublish: true, canPublishSources: [CAMERA, SCREEN_SHARE] })).toBe('microphone');
  });

  it('a timed-out member (canPublish:false, empty list) is blocked entirely', () => {
    expect(publishBlockFromPermissions({ canPublish: false, canPublishSources: [] })).toBe('all');
  });

  it('canPublish:false wins even if a stale source list still names the mic', () => {
    expect(publishBlockFromPermissions({ canPublish: false, canPublishSources: [MICROPHONE] })).toBe('all');
  });

  it('no permissions reported yet means no block', () => {
    expect(publishBlockFromPermissions(undefined)).toBe('none');
    expect(publishBlockFromPermissions(null)).toBe('none');
  });
});

describe('isMicrophoneBlocked (roster "muted")', () => {
  it('shows a timed-out member as muted', () => {
    expect(isMicrophoneBlocked({ canPublish: false, canPublishSources: [] })).toBe(true);
  });

  it('shows a server-muted member as muted', () => {
    expect(isMicrophoneBlocked({ canPublish: true, canPublishSources: [CAMERA] })).toBe(true);
  });

  it('leaves a normal member alone', () => {
    expect(isMicrophoneBlocked({ canPublish: true, canPublishSources: [MICROPHONE, CAMERA] })).toBe(false);
    expect(isMicrophoneBlocked({ canPublish: true, canPublishSources: [] })).toBe(false);
  });
});

describe('publishBlockedReason (token response)', () => {
  it('reports a timeout, a server mute, or nothing', () => {
    expect(publishBlockedReason({ timedOut: true, voiceMuted: false })).toBe('timeout');
    expect(publishBlockedReason({ timedOut: false, voiceMuted: true })).toBe('server_mute');
    expect(publishBlockedReason({ timedOut: false, voiceMuted: false })).toBeNull();
  });

  it('a timeout wins over a server mute (it blocks more)', () => {
    expect(publishBlockedReason({ timedOut: true, voiceMuted: true })).toBe('timeout');
  });
});

describe('publishBlockAtJoin', () => {
  it('uses the live grant when the token reports nothing', () => {
    expect(publishBlockAtJoin(null, { canPublish: true, canPublishSources: [MICROPHONE] })).toBe('none');
    expect(publishBlockAtJoin(null, { canPublish: false, canPublishSources: [] })).toBe('all');
  });

  it('a timeout blocks everything even before LiveKit reports the grant', () => {
    expect(publishBlockAtJoin('timeout', undefined)).toBe('all');
  });

  it('a server mute blocks at least the microphone', () => {
    expect(publishBlockAtJoin('server_mute', undefined)).toBe('microphone');
    expect(publishBlockAtJoin('server_mute', { canPublish: true, canPublishSources: [CAMERA] })).toBe('microphone');
    // Server mute on a server with camera and screen share off: nothing is left.
    expect(publishBlockAtJoin('server_mute', { canPublish: false, canPublishSources: [] })).toBe('all');
  });
});

describe('resolvePublishBlockReason', () => {
  it('no block, no reason', () => {
    expect(resolvePublishBlockReason('none', 'timeout')).toBeNull();
    expect(resolvePublishBlockReason('none', null)).toBeNull();
  });

  it('a full block the token called a timeout is a timeout', () => {
    expect(resolvePublishBlockReason('all', 'timeout')).toBe('timeout');
  });

  it('a mic-only block is a server mute, whatever the join said', () => {
    expect(resolvePublishBlockReason('microphone', null)).toBe('server_mute');
    expect(resolvePublishBlockReason('microphone', 'timeout')).toBe('server_mute');
  });

  it('a full block mid-call without a token hint never claims a timeout', () => {
    expect(resolvePublishBlockReason('all', null)).toBe('server_mute');
    expect(resolvePublishBlockReason('all', 'server_mute')).toBe('server_mute');
  });
});
