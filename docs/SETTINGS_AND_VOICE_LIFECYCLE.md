# Settings and voice lifecycle

Settings opened from the lobby use Next.js parallel and intercepted routes. The URL changes to `/settings/*` or `/admin/*`, while the lobby and its `LobbyVoiceProvider` remain mounted underneath the full-screen modal. Closing with the X button or Escape performs a soft replace to `/lobby`, regardless of how many settings sections were visited. A direct visit to a settings URL still renders as a complete standalone page.

Normal settings navigation must never disconnect, mute, or deafen an active voice room.

Media tests are the only exception:

- Microphone test temporarily disables the published microphone and deafens remote audio to prevent echo. It stores the previous microphone and deafen states and restores both when the test stops or the settings view closes.
- Output test temporarily deafens remote audio while the test tone plays, then restores the previous state.
- Camera preview does not change voice state.

The bridge between the settings route and the mounted voice provider is the typed `lobbyforge:voice-test-state` browser event. It carries only the test kind and active state; device identifiers and media streams never cross this bridge.
