export type InputMode = 'voice_activity' | 'push_to_talk';
export type ScreenQuality = 'auto' | 'low' | 'standard' | 'high' | 'q1440' | 'q2160';
export type ScreenFps = '15' | '30' | '60';

export type VoiceVideoPreferences = {
  inputDeviceId: string;
  inputDeviceLabel: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  cameraDeviceId: string;
  cameraLabel: string;
  inputVolume: number;
  outputVolume: number;
  inputMode: InputMode;
  autoSensitivity: boolean;
  sensitivity: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  automaticGainControl: boolean;
  voiceIsolation: boolean;
  screenQuality: ScreenQuality;
  screenFps: ScreenFps;
  shareSystemAudio: boolean;
};

export const DEFAULT_VOICE_VIDEO_PREFERENCES: VoiceVideoPreferences = {
  inputDeviceId: 'default',
  inputDeviceLabel: 'Default microphone',
  outputDeviceId: 'default',
  outputDeviceLabel: 'Default speakers',
  cameraDeviceId: 'default',
  cameraLabel: 'Default camera',
  inputVolume: 85,
  outputVolume: 100,
  inputMode: 'voice_activity',
  autoSensitivity: true,
  sensitivity: 60,
  noiseSuppression: true,
  echoCancellation: true,
  automaticGainControl: true,
  voiceIsolation: false,
  screenQuality: 'auto',
  screenFps: '30',
  shareSystemAudio: true,
};

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : fallback;
}

function coerceInputMode(value: unknown): InputMode {
  return value === 'push_to_talk' ? 'push_to_talk' : 'voice_activity';
}

function coerceScreenQuality(value: unknown): ScreenQuality {
  return value === 'low' || value === 'standard' || value === 'high' || value === 'q1440' || value === 'q2160'
    ? value
    : 'auto';
}

function coerceScreenFps(value: unknown): ScreenFps {
  return value === '15' || value === '60' ? value : '30';
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export function mergeVoiceVideoPreferences(value: unknown): VoiceVideoPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    inputDeviceId: coerceString(input.inputDeviceId, DEFAULT_VOICE_VIDEO_PREFERENCES.inputDeviceId),
    inputDeviceLabel: coerceString(input.inputDeviceLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.inputDeviceLabel),
    outputDeviceId: coerceString(input.outputDeviceId, DEFAULT_VOICE_VIDEO_PREFERENCES.outputDeviceId),
    outputDeviceLabel: coerceString(input.outputDeviceLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.outputDeviceLabel),
    cameraDeviceId: coerceString(input.cameraDeviceId, DEFAULT_VOICE_VIDEO_PREFERENCES.cameraDeviceId),
    cameraLabel: coerceString(input.cameraLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.cameraLabel),
    inputVolume: clampVolume(input.inputVolume, DEFAULT_VOICE_VIDEO_PREFERENCES.inputVolume),
    outputVolume: clampVolume(input.outputVolume, DEFAULT_VOICE_VIDEO_PREFERENCES.outputVolume),
    inputMode: coerceInputMode(input.inputMode),
    autoSensitivity: coerceBool(input.autoSensitivity, DEFAULT_VOICE_VIDEO_PREFERENCES.autoSensitivity),
    sensitivity: clampVolume(input.sensitivity, DEFAULT_VOICE_VIDEO_PREFERENCES.sensitivity),
    noiseSuppression: coerceBool(input.noiseSuppression, DEFAULT_VOICE_VIDEO_PREFERENCES.noiseSuppression),
    echoCancellation: coerceBool(input.echoCancellation, DEFAULT_VOICE_VIDEO_PREFERENCES.echoCancellation),
    automaticGainControl: coerceBool(
      input.automaticGainControl,
      DEFAULT_VOICE_VIDEO_PREFERENCES.automaticGainControl
    ),
    voiceIsolation: coerceBool(input.voiceIsolation, DEFAULT_VOICE_VIDEO_PREFERENCES.voiceIsolation),
    screenQuality: coerceScreenQuality(input.screenQuality),
    screenFps: coerceScreenFps(input.screenFps),
    shareSystemAudio: coerceBool(input.shareSystemAudio, DEFAULT_VOICE_VIDEO_PREFERENCES.shareSystemAudio),
  };
}
