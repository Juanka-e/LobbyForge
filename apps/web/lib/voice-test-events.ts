export const VOICE_TEST_STATE_EVENT = 'lobbyforge:voice-test-state';

export type VoiceTestKind = 'microphone' | 'output';

export function setVoiceTestState(kind: VoiceTestKind, active: boolean): void {
  window.dispatchEvent(new CustomEvent(VOICE_TEST_STATE_EVENT, { detail: { kind, active } }));
}
