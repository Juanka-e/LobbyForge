# Tauri 2 Media Spike — LiveKit WebView2 Verification Checklist

Before declaring the Tauri desktop shell production-ready, we must verify
that LiveKit's WebRTC voice/video/screen-share works inside the Tauri
WebView2 (Windows) / WKWebView (macOS) / WebKitGTK (Linux) window.

## Prerequisites

1. **Running LobbyForge instance** (local or remote):
   ```sh
   docker compose -f infra/docker/docker-compose.dev.yml up -d
   pnpm --filter @lobbyforge/web dev
   ```

2. **Tauri desktop app built**:
   ```sh
   pnpm --filter @lobbyforge/desktop dev
   ```

3. **Two browser tabs** (or a second machine) for the two-user voice test.

4. **Microphone + camera permissions** granted to the Tauri app (OS-level).

## Test Checklist

### A. Connection & Authentication
- [ ] Tauri window opens to the connect screen
- [ ] Entering the instance URL (e.g. `http://localhost:3000`) loads the lobby
- [ ] Guest session is created (visible as "Guest" in the members panel)
- [ ] The instance URL persists after closing and reopening the app

### B. Voice (Audio)
- [ ] Clicking a voice channel connects (green "Voice Connected" label)
- [ ] Mic toggle works — mute/unmute icon updates
- [ ] **Two-user test:** User A in Tauri, User B in browser — they can hear each other
- [ ] Speaking indicator (green ring) appears when the other user talks
- [ ] Deafen toggle mutes all incoming audio
- [ ] Disconnect returns to "Voice Ready" state

### C. Camera (Video)
- [ ] Camera toggle shows local video tile
- [ ] **Two-user test:** both users see each other's camera tile
- [ ] Speaking ring appears on the correct tile
- [ ] Camera off hides the tile

### D. Screen Share
- [ ] Screen share toggle starts sharing
- [ ] **Two-user test:** the other user sees the shared screen (auto-pinned large tile)
- [ ] Stopping screen share returns to normal grid
- [ ] Click-to-focus on a participant tile works

### E. Global Push-to-Talk
- [ ] Holding `Ctrl+Space` while Tauri is NOT focused unmutes the mic
- [ ] Releasing `Ctrl+Space` mutes the mic
- [ ] The `lobbyforge:ptt` event reaches the instance webview

### F. Tray & Window
- [ ] Tray icon appears in the system tray
- [ ] "Show" brings the window to the front
- [ ] "Quit" exits the app cleanly
- [ ] Second instance launch focuses the existing window (single-instance)

### G. Performance
- [ ] Memory usage < 300 MB during a voice call (check Task Manager)
- [ ] CPU usage < 10% when idle (no voice connection)
- [ ] No audio glitches/dropouts during a 5-minute call

## Known Risks

| Risk | Mitigation |
|------|------------|
| WebView2 audio autoplay policy | LiveKit uses `position:absolute;width:0;height:0` (not `display:none`) for audio elements — should work. If silent, check `autoplay` policy. |
| Screen share API differences | `getDisplayMedia` in WebView2 may require a user gesture. Tauri's `--auto-select-desktop-capture-source` flag handles this. |
| Mic permission dialog | Windows may prompt for mic access the first time. The user must allow it in the OS settings. |
| UDP port range | LiveKit needs ports 50000-60000/udp open. If behind NAT, TURN is required. |

## Fallback

If WebView2 media is unreliable, the Electron fallback is documented in
`projectdetails/16_ELECTRON_DESKTOP.md`. The Tauri shell code is
isolated enough that switching to Electron would only require replacing
`apps/desktop/src-tauri/` — the web app + connect screen are shared.
