# @lobbyforge/desktop

The Tauri 2 native desktop shell for LobbyForge. A thin, capability-scoped
client that connects to a user-provided self-hosted LobbyForge instance — it
does **not** bundle the Next.js web app (which requires Node + Postgres +
Redis and runs on the instance server).

## Architecture (connect-to-server)

1. **Connect screen** — on launch, the shell shows a card asking for the
   instance URL (e.g. `https://my.lobbyforge.dev`). The URL is validated
   (HTTPS origin, no credentials/query/fragment) and persisted.
2. **Instance webview** — the validated URL loads inside a full-bleed iframe.
   The instance owns its own UI, auth, and LiveKit voice; the shell only
   navigates and forwards native events.
3. **Native capabilities** owned by the shell:
   - **Single-instance** — a second launch focuses the existing window.
   - **Tray** — Show / Quit menu; window can be hidden to tray.
   - **Global push-to-talk** — hold `Ctrl+Space` while another app has focus;
     the shell forwards `pressed`/`released` to the instance webview via a
     `lobbyforge:ptt` postMessage.
   - **Persisted instance** — the last URL is restored on next launch.
   - **Deep-link auth** (infrastructure) — `lobbyforge://session/complete`
     handler wires into the existing `parseDesktopSessionHandoff` contract.

## Layout

```
apps/desktop/
  src/                     # TypeScript shell contracts (handoff validators, shortcut maps)
    index.ts
    __tests__/
  src-tauri/               # Rust native shell (Tauri 2)
    Cargo.toml
    tauri.conf.json
    build.rs
    src/{lib.rs, main.rs}
    capabilities/          # permission scopes
    icons/                 # generated icon set (run `pnpm tauri icon`)
  dist-shell/              # the connect-screen frontend (static HTML/JS)
    index.html
    shell.js
```

## Prerequisites

- **Rust** (stable, MSVC toolchain on Windows) — `rustup`
- **Microsoft C++ Build Tools** (MSVC linker) — bundled with Visual Studio Build Tools
- **WebView2 Runtime** — preinstalled on Windows 10/11

## Develop

```sh
pnpm install
pnpm --filter @lobbyforge/desktop dev   # tauri dev — opens the window
```

## Build a distributable

```sh
pnpm --filter @lobbyforge/desktop build  # tsc + tauri build → MSI/NSIS installer
```

The installers land in `src-tauri/target/release/bundle/`.

## Notes

- This shell cannot run standalone — it needs a LobbyForge instance to connect
  to. For local development, point it at `http://localhost:3000` (loopback http
  is permitted only in debug builds).
- The `src/index.ts` TypeScript contracts (handoff validation, shortcut
  accelerators) are kept for the future web-side deep-link emitter and are
  unit-tested independently of the Rust shell.
