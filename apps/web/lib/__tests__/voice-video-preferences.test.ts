import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOICE_VIDEO_PREFERENCES,
  mergeVoiceVideoPreferences,
} from '../voice-video-preferences.js';

describe('mergeVoiceVideoPreferences', () => {
  it('returns the defaults for non-object input', () => {
    expect(mergeVoiceVideoPreferences(undefined)).toEqual(DEFAULT_VOICE_VIDEO_PREFERENCES);
    expect(mergeVoiceVideoPreferences(null)).toEqual(DEFAULT_VOICE_VIDEO_PREFERENCES);
    expect(mergeVoiceVideoPreferences('oops')).toEqual(DEFAULT_VOICE_VIDEO_PREFERENCES);
    expect(mergeVoiceVideoPreferences([1, 2])).toEqual(DEFAULT_VOICE_VIDEO_PREFERENCES);
  });

  it('returns the defaults for an empty object', () => {
    expect(mergeVoiceVideoPreferences({})).toEqual(DEFAULT_VOICE_VIDEO_PREFERENCES);
  });

  it('applies valid partial overrides while keeping defaults for the rest', () => {
    const merged = mergeVoiceVideoPreferences({ inputMode: 'push_to_talk', inputVolume: 42 });
    expect(merged.inputMode).toBe('push_to_talk');
    expect(merged.inputVolume).toBe(42);
    // Untouched fields keep their defaults.
    expect(merged.echoCancellation).toBe(DEFAULT_VOICE_VIDEO_PREFERENCES.echoCancellation);
    expect(merged.screenQuality).toBe(DEFAULT_VOICE_VIDEO_PREFERENCES.screenQuality);
  });

  it('clamps volume to an integer in [0,100]', () => {
    expect(mergeVoiceVideoPreferences({ inputVolume: 0 }).inputVolume).toBe(0);
    expect(mergeVoiceVideoPreferences({ inputVolume: 100 }).inputVolume).toBe(100);
    // 50.6 rounds down to 51 (within range, rounded).
    expect(mergeVoiceVideoPreferences({ inputVolume: 50.6 }).inputVolume).toBe(51);
    // Out-of-range values fall back to the default.
    expect(mergeVoiceVideoPreferences({ inputVolume: 100.4 }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
    expect(mergeVoiceVideoPreferences({ inputVolume: 150 }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
    expect(mergeVoiceVideoPreferences({ inputVolume: -1 }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
  });

  it('rejects non-number volumes (string, NaN, Infinity)', () => {
    expect(mergeVoiceVideoPreferences({ inputVolume: '85' }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
    expect(mergeVoiceVideoPreferences({ inputVolume: NaN }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
    expect(mergeVoiceVideoPreferences({ inputVolume: Infinity }).inputVolume).toBe(
      DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume
    );
  });

  it('coerces unknown inputMode values to voice_activity', () => {
    expect(mergeVoiceVideoPreferences({ inputMode: 'bogus' }).inputMode).toBe('voice_activity');
    expect(mergeVoiceVideoPreferences({ inputMode: 123 }).inputMode).toBe('voice_activity');
    expect(mergeVoiceVideoPreferences({ inputMode: 'voice_activity' }).inputMode).toBe('voice_activity');
  });

  it('only accepts known screenQuality values, else auto', () => {
    for (const q of ['low', 'standard', 'high', 'q1440', 'q2160'] as const) {
      expect(mergeVoiceVideoPreferences({ screenQuality: q }).screenQuality).toBe(q);
    }
    expect(mergeVoiceVideoPreferences({ screenQuality: 'ultra' }).screenQuality).toBe('auto');
    expect(mergeVoiceVideoPreferences({ screenQuality: null }).screenQuality).toBe('auto');
  });

  it('only accepts 15 or 60 for screenFps, else 30', () => {
    expect(mergeVoiceVideoPreferences({ screenFps: '15' }).screenFps).toBe('15');
    expect(mergeVoiceVideoPreferences({ screenFps: '60' }).screenFps).toBe('60');
    // 30 is the fallback — passing it (or anything else) yields 30.
    expect(mergeVoiceVideoPreferences({ screenFps: '30' }).screenFps).toBe('30');
    expect(mergeVoiceVideoPreferences({ screenFps: '120' }).screenFps).toBe('30');
  });

  it('only accepts real booleans for boolean fields', () => {
    expect(mergeVoiceVideoPreferences({ echoCancellation: false }).echoCancellation).toBe(false);
    expect(mergeVoiceVideoPreferences({ echoCancellation: 'false' }).echoCancellation).toBe(true);
    expect(mergeVoiceVideoPreferences({ noiseSuppression: 0 }).noiseSuppression).toBe(true);
  });

  it('rejects empty/whitespace strings for device fields', () => {
    expect(mergeVoiceVideoPreferences({ inputDeviceId: '' }).inputDeviceId).toBe('default');
    expect(mergeVoiceVideoPreferences({ inputDeviceId: '   ' }).inputDeviceId).toBe('default');
    expect(mergeVoiceVideoPreferences({ cameraLabel: 'Logitech C920' }).cameraLabel).toBe('Logitech C920');
  });

  it('ignores unknown extra keys', () => {
    const merged = mergeVoiceVideoPreferences({ rogueField: 'x', inputVolume: 50 });
    expect((merged as Record<string, unknown>).rogueField).toBeUndefined();
    expect(merged.inputVolume).toBe(50);
  });
});
