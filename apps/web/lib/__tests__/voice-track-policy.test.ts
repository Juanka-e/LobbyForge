import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasAllowedAudioPublication,
  isRemotePublicationAllowed,
  isTrackInfoAllowed,
  isTrackKindAllowedForSource,
  protoTrackKind,
  protoTrackSource,
} from '../voice-track-policy';

describe('isTrackKindAllowedForSource (security-review AUTHZ-006 follow-up)', () => {
  it('allows audio only under the microphone and screen-share audio sources', () => {
    expect(isTrackKindAllowedForSource('audio', 'microphone')).toBe(true);
    expect(isTrackKindAllowedForSource('audio', 'screen_share_audio')).toBe(true);
    expect(isTrackKindAllowedForSource('audio', 'camera')).toBe(false);
    expect(isTrackKindAllowedForSource('audio', 'screen_share')).toBe(false);
    expect(isTrackKindAllowedForSource('audio', 'unknown')).toBe(false);
  });

  it('allows video only under the camera and screen-share sources', () => {
    expect(isTrackKindAllowedForSource('video', 'camera')).toBe(true);
    expect(isTrackKindAllowedForSource('video', 'screen_share')).toBe(true);
    expect(isTrackKindAllowedForSource('video', 'microphone')).toBe(false);
    expect(isTrackKindAllowedForSource('video', 'screen_share_audio')).toBe(false);
    expect(isTrackKindAllowedForSource('video', 'unknown')).toBe(false);
  });

  it('refuses unknown kinds and missing values', () => {
    expect(isTrackKindAllowedForSource('unknown', 'microphone')).toBe(false);
    expect(isTrackKindAllowedForSource('data', 'camera')).toBe(false);
    expect(isTrackKindAllowedForSource(undefined, 'camera')).toBe(false);
    expect(isTrackKindAllowedForSource('audio', undefined)).toBe(false);
    expect(isTrackKindAllowedForSource(1, 2)).toBe(false);
  });

  it('accepts the grant spelling (screen-share-audio) and upper case', () => {
    expect(isTrackKindAllowedForSource('audio', 'screen-share-audio')).toBe(true);
    expect(isTrackKindAllowedForSource('VIDEO', 'SCREEN_SHARE')).toBe(true);
    expect(isTrackKindAllowedForSource('AUDIO', 'CAMERA')).toBe(false);
  });
});

describe('isRemotePublicationAllowed', () => {
  it('passes a normal microphone and camera publication', () => {
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'microphone', mimeType: 'audio/opus' })).toBe(true);
    expect(isRemotePublicationAllowed({ kind: 'video', source: 'camera', mimeType: 'video/VP8' })).toBe(true);
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'microphone' })).toBe(true);
  });

  it('refuses audio labelled camera / screen share, and video labelled microphone', () => {
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'camera' })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'screen_share' })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'video', source: 'microphone' })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'unknown' })).toBe(false);
  });

  it('refuses a publication whose mime type or arriving media contradicts its kind', () => {
    expect(isRemotePublicationAllowed({ kind: 'video', source: 'camera', mimeType: 'audio/opus' })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'video', source: 'camera' }, { kind: 'audio' })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'video', source: 'camera', track: { kind: 'audio' } })).toBe(false);
    expect(isRemotePublicationAllowed({ kind: 'audio', source: 'microphone' }, { kind: 'audio' })).toBe(true);
  });
});

describe('hasAllowedAudioPublication (speaking indicator)', () => {
  it('is true only for real audio under an audio source', () => {
    expect(hasAllowedAudioPublication([{ kind: 'audio', source: 'microphone' }])).toBe(true);
    expect(hasAllowedAudioPublication([{ kind: 'audio', source: 'screen_share_audio' }])).toBe(true);
    expect(hasAllowedAudioPublication([{ kind: 'audio', source: 'camera' }])).toBe(false);
    expect(hasAllowedAudioPublication([{ kind: 'video', source: 'camera' }])).toBe(false);
    expect(hasAllowedAudioPublication([])).toBe(false);
    expect(
      hasAllowedAudioPublication([
        { kind: 'audio', source: 'screen_share' },
        { kind: 'audio', source: 'microphone' },
      ])
    ).toBe(true);
  });
});

describe('server side: protocol TrackInfo (webhook)', () => {
  it('maps the protocol enums, treating omitted zero values as AUDIO / UNKNOWN', () => {
    expect(protoTrackKind(0)).toBe('audio');
    expect(protoTrackKind(undefined)).toBe('audio');
    expect(protoTrackKind(1)).toBe('video');
    expect(protoTrackKind(2)).toBe('data');
    expect(protoTrackKind(99)).toBe('unknown');
    expect(protoTrackSource(undefined)).toBe('unknown');
    expect(protoTrackSource(1)).toBe('camera');
    expect(protoTrackSource(2)).toBe('microphone');
    expect(protoTrackSource(3)).toBe('screen_share');
    expect(protoTrackSource(4)).toBe('screen_share_audio');
    expect(protoTrackSource(42)).toBe('unknown');
  });

  it('allows a microphone audio track and camera / screen-share video', () => {
    expect(isTrackInfoAllowed({ type: 0, source: 2, mimeType: 'audio/opus' })).toBe(true);
    expect(isTrackInfoAllowed({ source: 2 })).toBe(true); // type omitted = AUDIO
    expect(isTrackInfoAllowed({ type: 0, source: 4, mimeType: 'audio/red' })).toBe(true);
    expect(isTrackInfoAllowed({ type: 1, source: 1, mimeType: 'video/VP8' })).toBe(true);
    expect(isTrackInfoAllowed({ type: 1, source: 3, mimeType: 'video/H264' })).toBe(true);
  });

  it('refuses mislabelled, unknown-source and data tracks', () => {
    expect(isTrackInfoAllowed({ type: 0, source: 1 })).toBe(false); // audio as camera
    expect(isTrackInfoAllowed({ source: 3 })).toBe(false); // audio as screen share
    expect(isTrackInfoAllowed({ type: 1, source: 2 })).toBe(false); // video as microphone
    expect(isTrackInfoAllowed({ type: 1, source: 4 })).toBe(false); // video as screen audio
    expect(isTrackInfoAllowed({})).toBe(false); // audio, unknown source
    expect(isTrackInfoAllowed({ type: 2, source: 1 })).toBe(false); // data track
  });

  it('refuses a track whose negotiated mime type contradicts its declared type', () => {
    expect(isTrackInfoAllowed({ type: 1, source: 1, mimeType: 'audio/opus' })).toBe(false);
    expect(isTrackInfoAllowed({ type: 0, source: 2, mimeType: 'video/VP8' })).toBe(false);
  });
});

describe('the standalone room page applies the rule at every remote-track entry point', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'room', '[roomName]', 'page.tsx'), 'utf8');

  it('unsubscribes a mislabelled track on publish, on subscribe and for tracks already in the room', () => {
    expect(source).toMatch(
      /RoomEvent\.TrackPublished, \(publication: RemoteTrackPublication\) => \{\s*if \(!isRemotePublicationAllowed\(publication\)\) publication\.setSubscribed\(false\);/
    );
    // Checked BEFORE the audio element is attached.
    expect(source).toMatch(
      /RoomEvent\.TrackSubscribed, \(track: RemoteTrack, publication: RemoteTrackPublication\) => \{\s*if \(!isRemotePublicationAllowed\(publication, track\)\) \{\s*publication\.setSubscribed\(false\);\s*return;\s*\}[\s\S]{0,200}track\.attach\(\)/
    );
    expect(source).toMatch(
      /for \(const participant of room\.remoteParticipants\.values\(\)\) \{\s*for \(const publication of participant\.trackPublications\.values\(\)\) \{\s*if \(!isRemotePublicationAllowed\(publication\)\) publication\.setSubscribed\(false\);/
    );
    expect(source).toContain('isAudiblySpeaking(p) ?');
    expect(source).not.toContain('p.isSpeaking ?');
  });
});
