# 16 - Tauri Desktop Client

> Historical filename retained so existing links do not break. The earlier Electron decision is superseded by a Tauri 2-first desktop strategy.

## 1. Decision

The main product remains the Web/PWA application. The desktop client is a thin,
open-source convenience shell for Windows, macOS, and Linux.

LobbyForge will use **Tauri 2** as the primary desktop direction because the
desktop package is still a scaffold and no Electron-specific production code
exists. Electron remains a fallback only if the media spike exposes a blocking
WebView2/WebKit limitation.

## 2. Why Tauri

- Uses the operating system webview instead of bundling Chromium.
- Lower baseline download, disk, and memory cost fits an application that may remain open all day.
- Official plugins cover global shortcuts, notifications, deep links, single-instance behavior, persisted settings, window state, and signed updates.
- Tauri capabilities keep native commands deny-by-default and scoped to the windows that need them.
- React/Next and the TypeScript domain packages remain the source of truth; Rust is limited to the native shell and audited bridges.

## 3. Architecture boundary

The desktop shell must not give arbitrary self-host pages unrestricted native access.

```txt
Tauri local shell
  - connection manager
  - saved instances
  - tray / global PTT / notifications / updater
  - official account sync (optional)

Instance webview
  - isolated per origin
  - normal instance cookies remain origin-bound
  - no shell, filesystem, process, or updater capability
  - receives only a small audited desktop event bridge
```

The local/bundled shell owns native capabilities. A remote instance webview
does not receive generic Tauri APIs. Global PTT is forwarded as a fixed
`pressed`/`released` event to the active instance view; remote content cannot
execute arbitrary native commands.

## 4. Account and DM model

The desktop app supports the official hub, public registry instances, and
manual HTTPS connections. Official sync may store saved instance references,
desktop preferences, and global keybinds. Local instance sessions,
memberships, roles, bans, messages, and instance DMs remain owned by that
instance.

Official friends/DMs are a separate central product surface. They never merge
silently with an instance's local DMs or moderation records.

## 5. Native feature set

First desktop milestone:

- tray and start-minimized behavior
- global push-to-talk with press and release events
- mute/deafen shortcuts
- native notifications while the app is running
- deep-link auth callback with state validation and one-time codes
- single-instance handling
- persisted window position and safe local preferences
- signed stable/beta updates

Later: always-on-top compact activity/voice overlay, official preference sync,
and richer notification actions.

## 6. Security rules

- No arbitrary shell/process execution capability.
- No generic filesystem capability for remote instance views.
- Native commands use narrow typed payloads and explicit capability grants.
- Instance URLs are HTTPS origins; loopback HTTP is development-only.
- Auth handoff uses short-lived one-time codes, state binding, and secret redaction.
- Update artifacts and release metadata are signed; production packages are code-signed/notarized per platform.
- Navigating to a new origin never inherits native privileges from the previous one.

## 7. Mandatory media spike

Before calling the Tauri choice final, a Windows 10/11 spike must prove:

1. LiveKit join/leave and remote audio between two clients.
2. Microphone/camera permissions and device switching.
3. Entire-screen and window sharing, including browser-native stop sharing.
4. Global PTT press/release while another application has focus.
5. Deep-link login handoff without exposing session cookies or codes in logs.
6. Tray restore, native notification, signed updater dry-run, and crash recovery.
7. Memory/install-size comparison against the same Electron wrapper.

If WebView2 media behavior is unreliable after a bounded spike, Electron may be
used as the compatibility fallback. Product and auth boundaries do not change.

## 8. Repository direction

```txt
apps/desktop/
  src/                  # TypeScript shell contracts and tests
  src-tauri/
    src/
      lib.rs
      ptt.rs
      deep_link.rs
    capabilities/
    tauri.conf.json
    Cargo.toml
```

Do not add Tauri dependencies until the media spike begins. The current URL
normalization and handoff contracts remain reusable.
