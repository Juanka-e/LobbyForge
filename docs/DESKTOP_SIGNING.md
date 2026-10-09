# Desktop installer and code signing

What the Windows installer looks like now, how code signing switches itself
on, and what you (the owner) have to buy, apply for and configure. The
reasoning behind the choices is in
[DESKTOP_SIGNING_INSTALLER_RESEARCH_2026-10.md](DESKTOP_SIGNING_INSTALLER_RESEARCH_2026-10.md)
and ADR-005 in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md).

**Today: nothing is signed, and every build is green.** Signing turns on by
itself for a platform as soon as its secrets exist in GitHub. Until then
Windows shows "Windows protected your PC" and macOS blocks the first open, as
before.

## The Windows installer

### What users see

Double-clicking `LobbyForge_<version>_x64-setup.exe` installs without
questions, the way Discord does:

1. No admin prompt. The app installs for the current user, in
   `%LOCALAPPDATA%\LobbyForge`.
2. A small dark window with the LobbyForge header and a progress bar. It
   closes itself after a second or two.
3. LobbyForge opens.

The installer also creates a Start Menu entry and a desktop shortcut,
registers `lobbyforge://` links, and appears in Settings → Apps with an
uninstaller. The uninstaller asks for confirmation and offers to delete the
app data; the data stays unless you tick that box.

The installer speaks English and Turkish, and picks the Windows display
language without asking. Any other language gets English.

**Updating:** download the new installer and run it. If LobbyForge is open,
the installer closes it, replaces the files in place, keeps the shortcuts and
settings, and opens the new version. Running the same version again
reinstalls it; Tauri does that by uninstalling first, so a LobbyForge icon
pinned to the taskbar has to be pinned again.

### Command-line switches

| Switch | Effect |
|---|---|
| (none) | One-click install, then the app opens |
| `/WIZARD` | The classic wizard: welcome, install folder, finish page with "Run LobbyForge" and "Create desktop shortcut" |
| `/S` | Silent: no window, the app does not open (winget, scripts, the CI smoke test) |
| `/P` | Passive: progress window only, the app opens only with `/R` |
| `/R` | With `/S` or `/P`: open the app when done |
| `/NS` | No shortcuts |
| `/D=C:\path` | Install folder (NSIS standard; must be the last switch) |

Silent uninstall: `"%LOCALAPPDATA%\LobbyForge\uninstall.exe" /S`.

### The MSI

The MSI stays as a second download for organisations that deploy software
centrally. It always installs for all users, so it asks for admin rights; that
is fixed in Tauri's WiX template. It carries the same branding, in English
only (WiX builds one MSI per language). CI builds it only for versions without
a pre-release suffix (WiX rejects `rc.1`), and not in Certum-signed builds
(see below).

### Artwork

`node apps/desktop/scripts/make-installer-assets.mjs` (or
`pnpm --filter @lobbyforge/desktop installer:assets`) draws every installer
image from `apps/desktop/src-tauri/appicon.png` in the web theme's dark
colours and writes them to `apps/desktop/src-tauri/installer/`:

| File | Size | Used by |
|---|---|---|
| `installer.ico` | 16–256 px | installer and uninstaller icon |
| `nsis/header.bmp` | 150×57 | header band of every installer and uninstaller page |
| `nsis/sidebar.bmp` | 164×314 | welcome and finish pages (`/WIZARD`) |
| `wix/banner.bmp` | 493×58 | top of the MSI dialogs |
| `wix/dialog.bmp` | 493×312 | MSI welcome and finish dialogs |

Re-run it after changing the icon and commit the result. The text in the
images is rendered with the fonts of your machine (Segoe UI on Windows).

### How it is built

`apps/desktop/src-tauri/installer/nsis/installer.nsi` is a copy of Tauri's
own NSIS template (tauri-bundler 2.9.4, the one inside `@tauri-apps/cli`
2.11.4) with four small, fenced changes:

1. Brand colours for the header band and the welcome/finish pages.
2. One-click by default: Tauri's passive mode, unless `/WIZARD`, `/P`, `/S` or
   `/UPDATE` is given.
3. In passive mode the progress page shows only the heading ("Installing,
   please wait") and the bar: the per-file status line, the log, Back/Next and
   the branding line are hidden, the page turns dark, and the window shrinks
   to the header, the bar and Cancel. Cancel stays so that a failed install
   can be closed; the heading then says the install was aborted, and
   `/WIZARD` shows the full log. The wizard keeps Tauri's status line.
4. A one-click install opens the app at the end.

Uninstall, upgrade, WebView2 setup, shortcuts, deep links and the signing
hooks are Tauri's code, unchanged. No closed-source NSIS skin is used:
SignPath Foundation accepts no closed-source components.

## How signing works

[`desktop-release.yml`](../.github/workflows/desktop-release.yml) is the only
place desktop installers are built. `release.yml` calls it for every `v*` tag
and publishes the result with the server release; you can also run it by hand
(Actions → desktop-release → Run workflow) for a test build, which adds a
Windows install/launch/reinstall/uninstall smoke test.

[`apps/desktop/scripts/release-signing.mjs`](../apps/desktop/scripts/release-signing.mjs)
looks at which secrets are set and decides:

| Secrets set | Windows | macOS |
|---|---|---|
| none | unsigned, green | unsigned, green |
| `CERTUM_EMAIL` + `CERTUM_OTP` | everything signed by Certum: app, uninstaller, installer | — |
| `SIGNPATH_API_TOKEN` + `SIGNPATH_ORGANIZATION_ID` | app and installers signed by SignPath (release tags) | — |
| `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` | — | Developer ID signed |
| … plus notarization secrets | — | signed and notarized |
| half of a set, or Certum and SignPath together | **build fails** with a message naming the missing secret | **build fails** |

Failing on half a configuration is deliberate: a release that silently comes
out unsigned is what you added the secrets to avoid.

Safety rules the workflow follows:
- Secrets live in a GitHub **environment** called `desktop-signing`, not in
  repository secrets. Add required reviewers there and every signing run
  waits for your click.
- The app is compiled in a step that sees no secret, so no build script or
  dependency can read them. Only the bundling step gets the secrets of the
  one provider in use.
- Secret values are never printed; the logs say which variable names are set.
- After bundling, the workflow checks the signatures (Windows:
  `Get-AuthenticodeSignature` on the installers and on the app inside the
  NSIS installer; macOS: `codesign`, `stapler`, `spctl`). A platform that
  fails uploads nothing, so it is missing from the release instead of
  published unsigned. The server release still goes out.
- `ssign` is downloaded from its GitHub release and checked against a pinned
  SHA-256; the SignPath action is pinned to a commit.

**Signing does not end the SmartScreen warning on day one.** A newly signed
installer still shows a warning until the certificate builds reputation, which
can take weeks and hundreds of clean installs. The difference is that the
warning names you as the publisher, and Smart App Control lets the app run.
Keep one signing identity: reputation belongs to the certificate.

## What you have to do

Pick **one** Windows route. The research recommends: apply to SignPath
Foundation now (free, but probably not accepted yet), and buy Certum when
public distribution gets close or SignPath says no.

### Route A: Certum Open Source code signing (SimplySign cloud)

Costs from €49. Your name appears on the certificate, as "Open Source
Developer, <your name>". Revoked if the software is ever sold.

1. Buy "Open Source Code Signing in the Cloud" at
   <https://shop.certum.eu/open-source-code-signing-on-simplysign.html>.
2. Complete identity verification: an ID photo, a bill in your name (proof of
   address) and the repository URL, <https://github.com/Juanka-e/LobbyForge>.
3. Install the SimplySign mobile app and activate it. **Before you scan the
   activation QR code**, save the secret it contains: the QR encodes an
   `otpauth://totp/...?secret=XXXX` link, and `XXXX` (base32) is the TOTP
   seed. Anyone with the seed and your e-mail can sign as you, so treat it
   like a private key; if it leaks, re-issue the QR code in Certum.
4. In GitHub: Settings → Environments → **New environment** → `desktop-signing`.
   - Deployment protection rules → **Required reviewers** → add yourself
     (recommended: every signing build waits for your approval).
   - Do not add branch or tag restrictions: manual test builds run from
     `main` and would be rejected.
   - Environment secrets:
     - `CERTUM_EMAIL`: your SimplySign account e-mail.
     - `CERTUM_OTP`: the base32 seed from step 3 (the full `otpauth://` link
       also works).
5. Run Actions → desktop-release → Run workflow, approve the deployment, and
   check the log of "Plan code signing" (`Windows signing: Certum SimplySign`)
   and "Verify Windows signatures" (`Valid`, signer = your certificate).
6. Download the `desktop-windows` artifact and verify it yourself (below).

From then on every `v*` release is signed. Certum builds ship the NSIS
installer only: `ssign` cannot sign MSI files yet, and an unsigned MSI next to
a signed EXE invites the wrong download.

Note: whether Certum's terms allow logging in automatically with the TOTP
seed could not be confirmed. If you prefer not to store the seed at all, use
the release-day fallback below instead of steps 4–5.

#### Release-day fallback: sign on your own Windows machine

The seed never leaves your phone; you type a one-time code instead.

1. Install the prerequisites from [DESKTOP.md](DESKTOP.md#build-from-source)
   (Rust, MSVC, Node, pnpm) and `ssign`: download
   `ssign-windows-x86_64.zip` from
   <https://github.com/Le-Syl21/ssign/releases> (version 0.1.7 has SHA-256
   `4ee5389a74ddbeb67e18fe8c8b963734ca13de7b24beffbe430c3f427ecc5e40`) and
   unzip `ssign.exe` somewhere on your `PATH`.
2. After the `v*` release workflow has finished, check out the tag and run:
   ```powershell
   git checkout v0.3.0
   pnpm install --frozen-lockfile
   pnpm --filter @lobbyforge/desktop sign:local -- --version 0.3.0
   ```
   It compiles first, then asks for your Certum e-mail and the current
   6-digit code from the SimplySign app (a code lasts 30 seconds; ssign keeps
   the session for 20 minutes, so one code signs everything), bundles the
   signed installer, checks the signature, and prints its SHA-256.
3. Run the two `gh release upload … --clobber` commands it prints: they
   replace the unsigned `desktop-windows-…-setup.exe` and its `.sha256` in the
   release. Update the matching line in the release's `SHA256SUMS.txt` the
   same way.

With SimplySign Desktop logged in (the certificate then sits in the Windows
certificate store) you can use the store instead of ssign:
`… sign:local -- --version 0.3.0 --thumbprint <certificate SHA-1 thumbprint>`.

### Route B: SignPath Foundation (free, if accepted)

The certificate says "SignPath Foundation", so your name does not appear.
Every release needs your manual approval in SignPath.

1. Keep two-factor authentication on for every GitHub account with write
   access.
2. Add a "Code signing policy" section to the project homepage or README:
   "Free code signing provided by SignPath.io, certificate by SignPath
   Foundation", the team roles (author, reviewer, approver: you) and a
   privacy sentence (the app only connects to the server the user enters).
3. Apply at <https://signpath.org/apply>.
4. Once accepted, in SignPath:
   - Create (or use) the project with slug `LobbyForge`.
   - Add two artifact configurations by pasting the files in
     [`apps/desktop/signing/signpath/`](../apps/desktop/signing/signpath/):
     `app-exe.xml` with slug `app-exe`, and `installers.xml` with slug
     `installers`.
   - Signing policies: `release-signing` (manual approval) and, optionally,
     `test-signing`.
   - Trusted build system: link the GitHub repository (GitHub.com connector).
   - Create an API token for a CI user that may submit to these policies.
5. In GitHub, environment `desktop-signing` (create it as in Route A):
   - secret `SIGNPATH_API_TOKEN`;
   - variable (or secret) `SIGNPATH_ORGANIZATION_ID`;
   - optional variables: `SIGNPATH_PROJECT_SLUG` (default `LobbyForge`),
     `SIGNPATH_POLICY_SLUG` (default `release-signing`),
     `SIGNPATH_TEST_POLICY_SLUG` (set it to `test-signing` to also sign manual
     test builds), `SIGNPATH_APP_ARTIFACT_CONFIG` (default `app-exe`),
     `SIGNPATH_INSTALLERS_ARTIFACT_CONFIG` (default `installers`).
   - Remove any `CERTUM_*` secrets: two providers fail the build.
6. On each `v*` release you get two signing requests per Windows build: first
   the app exe, then the installers. Approve both within an hour each.

How it works and what it cannot do: SignPath only signs files uploaded as
workflow artifacts, so it cannot hook into the Tauri build. The workflow
compiles the app, has SignPath sign the exe, builds the installers around the
signed exe, then has SignPath sign the installers. SignPath cannot open NSIS
installers, so the uninstaller that NSIS generates stays unsigned on this
route (Smart App Control may block it). The MSI and everything in it is
signed.

### macOS (when Mac users arrive)

Apple Developer Program, USD 99 per year; individuals get no fee waiver.

1. Join at <https://developer.apple.com/programs/>.
2. In Xcode or the developer portal create a **Developer ID Application**
   certificate, export it from Keychain Access as a `.p12` with a password,
   and base64-encode it: `base64 -i cert.p12 | pbcopy`.
3. Environment `desktop-signing` secrets:
   - `APPLE_CERTIFICATE`: the base64 text; `APPLE_CERTIFICATE_PASSWORD`: its
     password. Optional `APPLE_SIGNING_IDENTITY`, e.g.
     `Developer ID Application: Your Name (TEAMID)`.
   - Notarization, one of:
     - `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from
       appleid.apple.com) and `APPLE_TEAM_ID`; or
     - an App Store Connect API key: `APPLE_API_ISSUER`, `APPLE_API_KEY` (the
       key ID) and `APPLE_API_PRIVATE_KEY` (the contents of
       `AuthKey_<id>.p8`).

A certificate without notarization signs the app, but Gatekeeper still blocks
it; the log says so.

## Verifying a signed build

Windows, on the downloaded installer:
- Right-click → Properties → **Digital Signatures**: the signer is your
  certificate (or SignPath Foundation), with a timestamp.
- PowerShell:
  ```powershell
  Get-AuthenticodeSignature .\desktop-windows-LobbyForge_0.3.0_x64-setup.exe |
    Format-List Status, SignerCertificate, TimeStamperCertificate
  ```
  `Status` must be `Valid`.
- After installing, check `%LOCALAPPDATA%\LobbyForge\lobbyforge-desktop.exe`
  and `uninstall.exe` the same way.
- With the Windows SDK: `signtool verify /pa /v <file>`.
- Compare the SHA-256 with the release's `.sha256` file, as the download page
  explains.

macOS:
```sh
codesign -dv --verbose=4 /Applications/LobbyForge.app
spctl -a -vv /Applications/LobbyForge.app      # "accepted, source=Notarized Developer ID"
xcrun stapler validate /Applications/LobbyForge.app
```

## Secrets and variables reference

All in Settings → Environments → `desktop-signing`. `release.yml` passes them
to the desktop build by name; nothing else receives them.

| Name | Kind | Route | What |
|---|---|---|---|
| `CERTUM_EMAIL` | secret | Certum | SimplySign account e-mail |
| `CERTUM_OTP` | secret | Certum | TOTP seed from the SimplySign activation QR code |
| `SIGNPATH_API_TOKEN` | secret | SignPath | API token of the CI user |
| `SIGNPATH_ORGANIZATION_ID` | variable or secret | SignPath | organization ID |
| `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, `SIGNPATH_TEST_POLICY_SLUG`, `SIGNPATH_APP_ARTIFACT_CONFIG`, `SIGNPATH_INSTALLERS_ARTIFACT_CONFIG` | variables | SignPath | optional overrides, defaults above |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | secrets | macOS | Developer ID `.p12` (base64) and its password |
| `APPLE_SIGNING_IDENTITY` | secret | macOS | optional identity name |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | secrets | macOS | notarization with an Apple ID |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | secrets | macOS | notarization with an API key |

Not related: `LF_RELEASE_SIGNING_KEY` signs the server's release manifest, not
the desktop apps; the future Tauri updater key (`TAURI_SIGNING_PRIVATE_KEY`)
signs update packages, and neither affects SmartScreen.

## Publisher name

`bundle.publisher` in `apps/desktop/src-tauri/tauri.conf.json` is
**"LobbyForge contributors"**. It shows as the publisher in Settings → Apps and
as the company name in the exe's properties; the copyright line uses it too.
It used to be "LobbyForge", the same as the product name, which the Microsoft
Store does not accept.

It does not have to match the certificate; Windows shows the certificate's
name in security prompts either way. Change it if you prefer:
- your own name, matching a Certum certificate (it then also appears in
  Settings → Apps);
- your Microsoft Store developer display name, if you publish there.

Changing it again moves one registry key (`HKCU\Software\<publisher>\LobbyForge`,
which remembers the install folder); the default folder is the same, so
upgrades are not affected.

## Upgrading Tauri

The NSIS template is a copy of Tauri's, so every `@tauri-apps/cli` upgrade
needs a rebase. A unit test in `apps/desktop` fails when the installed CLI
version differs from the one in the template's `TAURI_TEMPLATE_BASE` line.

1. Find the bundler version of the new CLI:
   `https://crates.io/api/v1/crates/tauri-cli/<version>/dependencies`
   (`tauri-bundler`; it is published together with the CLI).
2. Download the old and the new crate
   (`https://static.crates.io/crates/tauri-bundler/tauri-bundler-<v>.crate`, a
   `.tar.gz`) and diff `src/bundle/windows/nsis/installer.nsi` between them.
3. Apply that diff to our template, keeping the four `LOBBYFORGE (n/4)`
   blocks, and update the header and `TAURI_TEMPLATE_BASE` line.
4. Build (`pnpm --filter @lobbyforge/desktop tauri build --bundles nsis`) and
   run the installer: one-click, `/WIZARD`, `/S`, an upgrade over a running
   app, and the uninstaller.
