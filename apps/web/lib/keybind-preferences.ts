export type KeybindAction =
  | 'pushToTalk'
  | 'toggleMute'
  | 'toggleDeafen'
  | 'toggleCamera'
  | 'toggleScreenShare';

export type KeybindPreferences = Record<KeybindAction, { code: string; label: string }>;

export const DEFAULT_KEYBIND_PREFERENCES: KeybindPreferences = {
  pushToTalk: { code: 'Space', label: 'Space' },
  toggleMute: { code: 'KeyM', label: 'M' },
  toggleDeafen: { code: 'KeyD', label: 'D' },
  toggleCamera: { code: 'KeyV', label: 'V' },
  toggleScreenShare: { code: 'KeyS', label: 'S' },
};

const KNOWN_ACTIONS = Object.keys(DEFAULT_KEYBIND_PREFERENCES) as KeybindAction[];

function coerceBind(value: unknown, fallback: { code: string; label: string }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  const code = typeof input.code === 'string' && input.code.length <= 64 ? input.code : fallback.code;
  const label = typeof input.label === 'string' && input.label.length <= 64 ? input.label : fallback.label;
  return { code, label };
}

export function mergeKeybindPreferences(value: unknown): KeybindPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return KNOWN_ACTIONS.reduce((acc, action) => {
    acc[action] = coerceBind(input[action], DEFAULT_KEYBIND_PREFERENCES[action]);
    return acc;
  }, {} as KeybindPreferences);
}
