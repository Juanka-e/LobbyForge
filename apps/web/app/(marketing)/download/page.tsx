import type { Metadata } from 'next';
import { getTranslator } from '@/lib/i18n/server';
import { rich } from '@/lib/i18n/rich';

/**
 * Download page — desktop installers. Honest about beta status (ADR-005:
 * unsigned builds; verify SHA256SUMS from the release). The web app is
 * fully functional on its own — the desktop shell is an opt-in extra.
 */

const REPO = 'https://github.com/Juanka-e/LobbyForge';
const RELEASES = `${REPO}/releases`;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('hub.download.meta.title'),
    description: t('hub.download.meta.description'),
  };
}

const PLATFORMS = [
  // Beta ships Windows as NSIS only — the MSI target cannot hold semver
  // pre-release identifiers (rc.2 drill finding). Revisit at stable.
  {
    icon: 'laptop_windows',
    name: 'Windows',
    formatsKey: 'hub.download.formats.windows',
  },
  {
    icon: 'laptop_mac',
    name: 'macOS',
    formatsKey: 'hub.download.formats.macos',
  },
  {
    icon: 'laptop_chromebook',
    name: 'Linux',
    formatsKey: 'hub.download.formats.linux',
  },
];

export default async function DownloadPage() {
  const t = await getTranslator();
  const linkClass =
    'text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary';
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <div className="max-w-2xl flex flex-col gap-4 mb-12">
        <p className="font-label-xs text-label-xs text-ember tracking-[0.2em] uppercase">
          <span className="align-middle mr-2 inline-block size-2 rounded-full bg-ember" />
          {t('hub.download.beta')}
        </p>
        <h1 className="font-display font-bold text-[36px] sm:text-[48px] leading-tight tracking-tight text-text-primary text-balance">
          {t('hub.download.title')}
        </h1>
        <p className="font-body-lg text-body-lg text-text-secondary text-pretty">
          {t('hub.download.intro')}
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
            <p className="text-sm text-text-muted">{t(p.formatsKey)}</p>
            <a
              href={RELEASES}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-auto border border-border-strong text-text-secondary px-5 py-2.5 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all text-center"
            >
              {t('hub.download.fromReleases')}
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
              {t('hub.download.unsigned.title')}
            </h2>
            <p className="text-sm text-text-secondary leading-relaxed mb-3">
              {rich(t('hub.download.unsigned.body'), {
                file: <span className="font-mono">&lt;installer&gt;.sha256</span>,
                ext: <span className="font-mono">.sha256</span>,
                adr: (
                  <a
                    href={`${REPO}/blob/main/docs/ARCHITECTURE_DECISIONS.md`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    ADR-005
                  </a>
                ),
              })}
            </p>
            <div className="flex flex-col gap-2">
              <code className="block rounded-lg bg-surface-container px-4 py-2.5 text-sm text-text-secondary overflow-x-auto">
                <span className="text-text-muted"># {t('hub.download.verify.windows')}</span>
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
        {rich(t('hub.download.selfHost'), {
          link: (
            <a href="/landing#self-host" className={linkClass}>
              {t('hub.download.selfHostLink')}
            </a>
          ),
        })}
      </p>
    </section>
  );
}
