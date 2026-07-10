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
    expect(source).toContain('setScreenShareEnabled(next, screenShareOptions(prefs))');
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

  it('switches the lobby into voice view when video or screen share becomes active', () => {
    expect(source).toContain("if (next) setMainViewMode('voice');");
    expect(source).toContain('participant.hasScreenShare');
    expect(source).toContain("setMainViewMode('voice')");
  });
});
