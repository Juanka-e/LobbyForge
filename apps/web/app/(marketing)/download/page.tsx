import type { Metadata } from 'next';

/**
 * Download page — desktop installers. Honest about beta status (ADR-005:
 * unsigned builds; verify SHA256SUMS from the release). The web app is
 * fully functional on its own — the desktop shell is an opt-in extra.
 */

const REPO = 'https://github.com/Juanka-e/LobbyForge';
const RELEASES = `${REPO}/releases`;

export const metadata: Metadata = {
  title: 'Download — LobbyForge desktop',
  description:
    'Optional desktop app for LobbyForge — the web app is fully functional on its own. Unsigned beta builds; verify checksums.',
};

const PLATFORMS = [
  // Beta ships Windows as NSIS only — the MSI target cannot hold semver
  // pre-release identifiers (rc.2 drill finding). Revisit at stable.
  {
    icon: 'laptop_windows',
    name: 'Windows',
    formats: 'NSIS installer (.exe)',
  },
  {
    icon: 'laptop_mac',
    name: 'macOS',
    formats: 'DMG (Apple Silicon)',
  },
  {
    icon: 'laptop_chromebook',
    name: 'Linux',
    formats: 'DEB / AppImage / RPM',
  },
];

export default function DownloadPage() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <div className="max-w-2xl flex flex-col gap-4 mb-12">
        <p className="font-label-xs text-label-xs text-ember tracking-[0.2em] uppercase">
          <span className="align-middle mr-2 inline-block size-2 rounded-full bg-ember" />
          Beta
        </p>
        <h1 className="font-display font-bold text-[36px] sm:text-[48px] leading-tight tracking-tight text-text-primary text-balance">
          Get the desktop app
        </h1>
        <p className="font-body-lg text-body-lg text-text-secondary text-pretty">
          A native window, tray and global push-to-talk for your communities. The web app is fully
          functional on its own — the desktop shell is an opt-in extra, and per-platform
          availability may vary between beta releases.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        {PLATFORMS.map((p) => (
          <div
            key={p.name}
            className="bg-surface/80 rounded-2xl border border-border-subtle/30 p-8 flex flex-col gap-4"
          >
            <span className="material-symbols-outlined text-primary text-3xl">{p.icon}</span>
            <h2 className="font-display font-bold text-xl text-text-primary">{p.name}</h2>
            <p className="text-sm text-text-muted">{p.formats}</p>
            <a
              href={RELEASES}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-auto border border-border-strong text-text-secondary px-5 py-2.5 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all text-center"
            >
              Download from GitHub Releases
            </a>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border-subtle/40 bg-surface/60 p-6 md:p-8 flex flex-col gap-4 mb-10">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-ember" aria-hidden>
            gpp_maybe
          </span>
          <div>
            <h2 className="font-label-sm text-label-sm text-text-primary mb-1">
              Beta builds are unsigned — verify what you download
            </h2>
            <p className="text-sm text-text-secondary leading-relaxed mb-3">
              Windows SmartScreen and macOS Gatekeeper will show a warning on first launch. Every
              release attaches a matching <span className="font-mono">&lt;installer&gt;.sha256</span>{' '}
              file next to each installer — download the installer AND its{' '}
              <span className="font-mono">.sha256</span> into the same folder, then verify ({' '}
              <a
                href={`${REPO}/blob/main/docs/ARCHITECTURE_DECISIONS.md`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
              >
                ADR-005
              </a>
              ):
            </p>
            <div className="flex flex-col gap-2">
              <code className="block rounded-lg bg-surface-container px-4 py-2.5 text-sm text-text-secondary overflow-x-auto">
                <span className="text-text-muted"># Windows (PowerShell) — prints OK or throws</span>
                <br />
                {'$e=(Get-Content .\\desktop-windows-*.exe.sha256)[0].Split(\' \')[0]; '}
                {'$a=(Get-FileHash .\\desktop-windows-*.exe -Algorithm SHA256).Hash.ToLower(); '}
                {"if($e -ne $a){throw 'Checksum mismatch'}else{'OK'}"}
              </code>
              <code className="block rounded-lg bg-surface-container px-4 py-2.5 text-sm text-text-secondary overflow-x-auto">
                <span className="text-text-muted"># macOS</span>
                <br />
                shasum -a 256 -c desktop-macos-LobbyForge_*.dmg.sha256
              </code>
              <code className="block rounded-lg bg-surface-container px-4 py-2.5 text-sm text-text-secondary overflow-x-auto">
                <span className="text-text-muted"># Linux</span>
                <br />
                sha256sum -c desktop-linux-LobbyForge_*.AppImage.sha256
              </code>
            </div>
          </div>
        </div>
      </div>

      <p className="text-sm text-text-muted">
        Rather run it in a browser tab on your own server?{' '}
        <a
          href="/landing#self-host"
          className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
        >
          Host LobbyForge yourself
        </a>
        .
      </p>
    </section>
  );
}
