import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lobby voice client integration', () => {
  const source = readFileSync(
    join(process.cwd(), 'app', 'lobby', 'LobbyVoiceProvider.tsx'),
    'utf8'
  );

  it('writes heartbeat data through the authenticated presence mutation route', () => {
    expect(source).toContain("fetch('/api/presence'");
    expect(source).toContain('serverId,');
    expect(source).toContain('channelId,');
    expect(source).not.toContain("fetch(`/api/servers/${serverId}/channels/${channelId}/presence`");
  });

  it('uses LiveKit participant names and no unsupported Room.getStats call', () => {
    expect(source).toContain('p.name || knownNames[identity] || identity');
    expect(source).not.toContain('room.getStats()');
  });

  it('samples RTC stats via the public getRTCStatsReport API and reports a delta on the heartbeat', () => {
    expect(source).toContain('getRTCStatsReport');
    expect(source).toContain('lastBandwidthBytesRef');
    expect(source).toContain('bandwidthDeltaBytes');
  });

  it('applies saved media-device preferences when publishing local tracks', () => {
    expect(source).toContain("fetch('/api/settings/me'");
    expect(source).toContain('setMicrophoneEnabled(next, audioCaptureOptions(prefs))');
    expect(source).toContain('setCameraEnabled(next, cameraCaptureOptions(prefs))');
    expect(source).toContain('setScreenShareEnabled(next, screenShareOptions(prefs, screenSharePolicyRef.current))');
  });

  it('implements push-to-talk from saved voice preferences', () => {
    expect(source).toContain("effectiveInputModeRef.current !== 'push_to_talk'");
    expect(source).toContain('keybindPrefsRef.current.pushToTalk.code');
    expect(source).toContain('isEditableTarget(event.target)');
  });

  it('applies server-side voice policy (requirePushToTalk / startMuted) from the token response', () => {
    expect(source).toContain('serverVoiceSettings');
    expect(source).toContain('serverRequiresPTT');
    expect(source).toContain('serverStartMuted');
  });

  it('opens local video in the voice view while remote streams remain opt-in', () => {
    expect(source).toContain("if (next) setMainViewMode('voice');");
    expect(source).toContain('autoSubscribe: false');
    expect(source).toContain('publication.setSubscribed(true)');
    expect(source).toContain('publication.setSubscribed(false)');
  });

  it('synchronizes camera and screen-share state from actual local track lifecycle events', () => {
    expect(source).toContain('RoomEvent.LocalTrackPublished');
    expect(source).toContain('RoomEvent.LocalTrackUnpublished');
    expect(source).toContain('Track.Source.ScreenShare');
    expect(source).toContain('setScreenShareEnabled(false)');
    expect(source).toContain("pub.track?.mediaStreamTrack.readyState === 'live'");
    expect(source).toContain('queueMicrotask');
  });
});
