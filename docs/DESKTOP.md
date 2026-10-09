# LobbyForge Desktop

The official native client for LobbyForge. Built with **Tauri 2** — a thin,
capability-scoped Rust shell that wraps a WebView2/WebKitGTK/WKWebView window
around a self-hosted LobbyForge instance.

## Connect-to-server model

The desktop app does **not** bundle the web app. LobbyForge's web app is a
Next.js server (SSR + API routes + Postgres + Redis + LiveKit) that runs on
your own server. The desktop client is a native window that loads your
instance URL inside a sandboxed webview and adds native capabilities the
browser can't provide.

**One official installer serves every instance.** On first launch the client
asks for the instance URL and remembers it. There is no per-instance branding
or build step — the same `.msi` / `.dmg` / `.deb` works for everyone.

```
┌──────────────────────────┐        ┌─────────────────────────────┐
│  Desktop client (Tauri)  │        │  Your LobbyForge instance   │
│                          │        │  (Next.js + PG + Redis +    │
│  ┌────────────────────┐  │ HTTPS  │  LiveKit on your server)    │
│  │  WebView →─────────┼──┼────────►│                             │
│  │  instance URL      │  │        │  /lobby  /admin  /api/...   │
│  └────────────────────┘  │        │                             │
│  + global PTT shortcut   │        └─────────────────────────────┘
│  + tray + notifications  │
│  + single instance       │
└──────────────────────────┘
```

## Download

Pre-built installers are attached to every LobbyForge **GitHub Release**
(`v*` tags), next to the server image, with SHA-256 checksums. They are built
by `desktop-release.yml`, which `release.yml` calls:

- **Windows**: `desktop-windows-LobbyForge_x.y.z_x64-setup.exe`. One click,
  no admin prompt: installs for the current user in `%LOCALAPPDATA%\LobbyForge`
  and opens the app. An `.msi` (per machine, admin) is added for versions
  without a pre-release suffix.
- **macOS**: `.dmg`
- **Linux**: `.deb`, `.rpm` or `.AppImage`

Code signing turns on when the signing secrets are configured; until then
Windows SmartScreen and macOS Gatekeeper warn on first run. See
[DESKTOP_SIGNING.md](DESKTOP_SIGNING.md) for the installer's switches and
the signing setup.

## First launch

1. Install the client.
2. On the connect screen, enter your instance URL (e.g.
   `https://lobby.example.com`). HTTPS is required; loopback `http://localhost`
   is permitted only in debug builds for local development.
3. Click **Connect**. The instance loads in the window and the URL is saved
   for next launch.
4. To switch instances later, click **"Switch instance"** in the top-right.

## Native capabilities

| Capability | Behavior |
|------------|----------|
| **Global push-to-talk** | Hold `Ctrl+Space` anywhere (even when the client isn't focused) to talk. The client forwards the key state to the instance via a `lobbyforge:ptt` event. |
| **Tray icon** | Hide the window to the system tray; "Show" / "Quit" menu. |
| **Single instance** | A second launch focuses the existing window instead of opening a duplicate. |
| **Persisted instance** | The last-connected URL is restored automatically on launch. |
| **Deep-link auth** (infrastructure) | `lobbyforge://session/complete?code=&state=&instance=` handler for the OAuth session handoff flow. |

## Build from source

### Prerequisites

- **Rust** (stable, MSVC toolchain on Windows): `rustup default stable-x86_64-pc-windows-msvc`
- **Windows**: Microsoft C++ Build Tools (MSVC) + Windows 11 SDK (via Visual Studio Installer → "Desktop development with C++")
- **Linux**: `libwebkit2gtk-4.1-dev librsvg2-dev patchelf`
- **macOS**: Xcode Command Line Tools
- **Node.js ≥ 22**, **pnpm ≥ 10.12.1**

### Develop

```sh
pnpm install
pnpm --filter @lobbyforge/desktop dev   # opens the window (tauri dev)
```

### Produce an installer

```sh
pnpm --filter @lobbyforge/desktop build  # tsc + tauri build
# → apps/desktop/src-tauri/target/release/bundle/
```

### Publish a release

Desktop installers ship with the unified release: pushing a `v*` tag runs
`release.yml`, which calls `desktop-release.yml` to build (and, when
configured, sign) all three platforms with the tag's version, then attaches
them to the GitHub Release. `desktop-v*` tags are no longer used.

For a test build, run **Actions → desktop-release → Run workflow**: the
installers are attached to the run, and a Windows smoke test installs,
launches, reinstalls and uninstalls the NSIS build.

## Security

- The instance webview is **isolated per origin** — it gets no shell,
  filesystem, process, or updater capability. Only the audited desktop event
  bridge (PTT forwarding) crosses the boundary.
- Instance URL validation enforces HTTPS origins only (loopback http in debug
  builds). Credentials, query strings, and fragments are rejected.
- Deep-link auth codes are never logged — the shell redacts `code=` before
  writing to logs (see `redactDesktopHandoff` in `src/index.ts`).

## Layout

```
apps/desktop/
  src/              # TS contracts (handoff validators, shortcut maps) + tests
  src-tauri/        # Rust native shell (Tauri 2)
    Cargo.toml
    tauri.conf.json
    src/{lib.rs, main.rs}
    capabilities/   # permission scopes
    icons/          # generated icon set (pnpm tauri icon)
  dist-shell/       # connect-screen frontend (static HTML/JS)
```
