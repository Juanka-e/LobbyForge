import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYBIND_PREFERENCES,
  mergeKeybindPreferences,
} from '../keybind-preferences.js';

describe('mergeKeybindPreferences', () => {
  it('returns the defaults for non-object input', () => {
    expect(mergeKeybindPreferences(undefined)).toEqual(DEFAULT_KEYBIND_PREFERENCES);
    expect(mergeKeybindPreferences(null)).toEqual(DEFAULT_KEYBIND_PREFERENCES);
    expect(mergeKeybindPreferences('x')).toEqual(DEFAULT_KEYBIND_PREFERENCES);
    expect(mergeKeybindPreferences([1])).toEqual(DEFAULT_KEYBIND_PREFERENCES);
  });

  it('returns the defaults for an empty object', () => {
    expect(mergeKeybindPreferences({})).toEqual(DEFAULT_KEYBIND_PREFERENCES);
  });

  it('applies a valid partial override for one action', () => {
    const merged = mergeKeybindPreferences({ pushToTalk: { code: 'KeyT', label: 'T' } });
    expect(merged.pushToTalk).toEqual({ code: 'KeyT', label: 'T' });
    // Untouched actions keep their defaults.
    expect(merged.toggleMute).toEqual(DEFAULT_KEYBIND_PREFERENCES.toggleMute);
  });

  it('truncates overly long code/label strings by falling back to the default', () => {
    const long = 'x'.repeat(100);
    const merged = mergeKeybindPreferences({ toggleMute: { code: long, label: 'M' } });
    expect(merged.toggleMute.code).toBe(DEFAULT_KEYBIND_PREFERENCES.toggleMute.code);
  });

  it('rejects non-object bind values', () => {
    const merged = mergeKeybindPreferences({ toggleMute: 'not-an-object' as unknown });
    expect(merged.toggleMute).toEqual(DEFAULT_KEYBIND_PREFERENCES.toggleMute);
  });

  it('rejects array bind values', () => {
    const merged = mergeKeybindPreferences({ toggleMute: ['KeyM', 'M'] as unknown });
    expect(merged.toggleMute).toEqual(DEFAULT_KEYBIND_PREFERENCES.toggleMute);
  });

  it('rejects non-string code/label', () => {
    const merged = mergeKeybindPreferences({ toggleMute: { code: 77, label: 'M' } as unknown });
    expect(merged.toggleMute.code).toBe(DEFAULT_KEYBIND_PREFERENCES.toggleMute.code);
  });

  it('drops unknown action keys', () => {
    const merged = mergeKeybindPreferences({
      rogueAction: { code: 'KeyX', label: 'X' },
      toggleCamera: { code: 'KeyC', label: 'C' },
    });
    expect((merged as Record<string, unknown>).rogueAction).toBeUndefined();
    expect(merged.toggleCamera).toEqual({ code: 'KeyC', label: 'C' });
  });

  it('preserves every known action key in the output', () => {
    const merged = mergeKeybindPreferences({});
    const keys = Object.keys(merged);
    expect(keys).toContain('pushToTalk');
    expect(keys).toContain('toggleMute');
    expect(keys).toContain('toggleDeafen');
    expect(keys).toContain('toggleCamera');
    expect(keys).toContain('toggleScreenShare');
  });
});
