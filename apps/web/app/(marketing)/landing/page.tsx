import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import VoiceStrip from './VoiceStrip';

export const metadata: Metadata = {
  title: 'LobbyForge — Your community. Your server. Your rules.',
  description:
    'Self-hosted voice, chat and live activities — without handing your community to a centralized platform.',
};

const REPO = 'https://github.com/Juanka-e/LobbyForge';

export default function LandingPage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  return (
    <>
      <Hero />
      <RoomPreview />
      <Values />
      <SelfHost />
      <FinalCta />
    </>
  );
}

function Hero() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10 lg:gap-16 items-center">
        <div>
          <p className="font-label-xs text-label-xs text-ember tracking-[0.2em] uppercase mb-5">
            Self-hosted voice communities
          </p>
          <h1 className="font-display font-extrabold text-[40px] leading-[1.05] sm:text-[56px] lg:text-[68px] tracking-tight text-text-primary mb-6 text-balance">
            Your community. Your server. Your rules.
          </h1>
          <p className="font-body-lg text-body-lg text-text-secondary mb-10 max-w-xl text-pretty">
            Self-hosted voice, chat and live activities — without handing your community to a
            centralized platform.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
            <a
              href="/discover"
              className="bg-primary-container text-on-primary-container px-8 py-4 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all text-center"
            >
              Explore communities
            </a>
            <a
              href="#self-host"
              className="border border-border-strong text-text-secondary px-8 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all text-center"
            >
              Host LobbyForge
            </a>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 text-text-muted px-4 py-4 rounded-lg font-label-sm text-label-sm hover:text-text-primary transition-colors"
            >
              {/* GitHub mark (public domain shape) */}
              <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Star on GitHub
              <GitHubStars />
            </a>
          </div>
        </div>
        <VoiceStrip />
      </div>
    </section>
  );
}

function RoomPreview() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <p className="font-label-xs text-label-xs text-text-muted tracking-[0.2em] uppercase mb-6">
        Inside a room
      </p>
      <HeroMockup />
    </section>
  );
}

function HeroMockup() {
  return (
    <div
      className="w-full rounded-[32px] bg-surface border border-border-subtle/30 overflow-hidden shadow-mockup relative flex"
      style={{ minHeight: 500 }}
    >
      {/* Left Sidebar */}
      <div className="w-64 bg-surface-raised border-r border-border-subtle/50 p-4 flex-col gap-4 hidden md:flex shrink-0">
        <div className="flex items-center gap-2 text-text-primary font-label-sm text-label-sm pb-4 border-b border-border-subtle/50">
          <span
            className="material-symbols-outlined text-primary"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            dns
          </span>
          Self-Hosted Server
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-text-muted font-label-xs text-label-xs mb-1">VOICE ROOMS</div>
          <div className="flex items-center gap-2 text-text-primary bg-surface-variant/50 p-2 rounded-lg">
            <span className="material-symbols-outlined text-text-secondary text-sm">volume_up</span>
            Main Lounge
          </div>
          <div className="flex items-center gap-2 text-text-secondary p-2 hover:bg-surface-variant/30 rounded-lg cursor-pointer">
            <span className="material-symbols-outlined text-sm">volume_up</span>
            Game Room 1
          </div>
        </div>
        <div className="mt-auto">
          <div className="flex items-center gap-2 text-primary bg-primary/10 p-2 rounded-lg font-label-xs text-label-xs border border-primary/20">
            <span
              className="material-symbols-outlined text-sm"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              health_and_safety
            </span>
            Doctor: All Systems Go
          </div>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-grow flex flex-col bg-background/50">
        <div className="h-16 border-b border-border-subtle/50 flex items-center px-6 justify-between bg-surface/50 backdrop-blur-sm z-10 sticky top-0">
          <div className="flex items-center gap-2 text-text-primary font-label-sm text-label-sm">
            <span className="material-symbols-outlined text-text-secondary">tag</span>
            Main Lounge
          </div>
          <div className="flex gap-2">
            <button className="bg-primary/20 border border-primary/30 px-3 py-1.5 rounded-md text-primary font-label-xs text-label-xs flex items-center gap-1 hover:brightness-110 transition-all">
              <span className="material-symbols-outlined text-sm">sports_esports</span>
              Start Activity
            </button>
          </div>
        </div>
        <div className="flex-grow flex flex-col overflow-y-auto">
          <div className="p-6 flex flex-col gap-6 mt-auto">
            {/* Activity Panel */}
            <div className="bg-surface-raised border border-primary/30 rounded-xl p-4 flex gap-4 items-center shadow-sm shadow-primary/5">
              <div className="w-12 h-12 bg-[#E7B86A]/20 border border-[#E7B86A]/30 rounded-lg flex items-center justify-center text-[#E7B86A] shrink-0">
                <span className="material-symbols-outlined">videogame_asset</span>
              </div>
              <div className="flex-grow">
                <div className="text-text-primary font-semibold text-label-sm">Hushle</div>
                <div className="text-text-secondary text-xs">Word guessing game • 2 playing</div>
              </div>
              <button className="bg-[#E7B86A] text-on-primary-container px-4 py-1.5 rounded font-bold text-label-xs hover:brightness-110 transition-all">
                Join Game
              </button>
            </div>
            {/* Chat Messages */}
            <div className="flex gap-4 items-start w-max">
              <div className="w-10 h-10 rounded-full bg-surface-variant flex items-center justify-center text-primary font-bold shrink-0">
                U
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-text-primary font-label-sm text-label-sm">User</span>
                  <span className="text-text-muted font-label-xs text-label-xs">12:00 PM</span>
                </div>
                <div className="text-text-secondary text-sm bg-surface p-3 rounded-lg border border-border-subtle/30 shadow-sm">
                  Ready to start the game?
                </div>
              </div>
            </div>
            <div className="flex gap-4 items-start w-max">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">
                B
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-text-primary font-label-sm text-label-sm">GameBot</span>
                  <span className="bg-primary/20 text-primary text-[10px] px-1 rounded uppercase font-bold tracking-wider">
                    Bot
                  </span>
                  <span className="text-text-muted font-label-xs text-label-xs">12:01 PM</span>
                </div>
                <div className="text-text-secondary text-sm bg-surface p-3 rounded-lg border border-border-subtle/30 shadow-sm">
                  Hushle lobby created. Type /join to play.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar */}
      <div className="w-60 bg-surface-raised border-l border-border-subtle/50 p-4 flex-col gap-4 hidden lg:flex shrink-0">
        <div className="text-text-muted font-label-xs text-label-xs mb-1">ONLINE — 2</div>
        <div className="flex items-center gap-3 p-2 hover:bg-surface-variant/30 rounded-lg cursor-pointer">
          <div className="w-8 h-8 rounded-full bg-surface-variant flex items-center justify-center text-primary font-bold text-xs relative">
            U
            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-success rounded-full border-2 border-surface-raised" />
          </div>
          <span className="text-text-secondary font-label-sm text-label-sm">User</span>
        </div>
        <div className="flex items-center gap-3 p-2 hover:bg-surface-variant/30 rounded-lg cursor-pointer">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs">
            B
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-secondary font-label-sm text-label-sm">GameBot</span>
            <span className="bg-primary/20 text-primary text-[10px] px-1 rounded uppercase font-bold tracking-wider">
              Bot
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Values() {
  const values = [
    {
      icon: 'record_voice_over',
      iconColor: 'text-primary',
      title: 'Voice-first',
      body: 'Low-latency voice rooms on LiveKit with TURN fallback — talking is the product, not an add-on.',
    },
    {
      icon: 'dns',
      iconColor: 'text-primary',
      title: 'Self-hosted',
      body: 'Your domain, your data, your rules. One VPS and a Docker install — no central account, ever.',
    },
    {
      icon: 'sports_esports',
      iconColor: 'text-ember',
      title: 'Live activities',
      body: 'Hushle and Quiz run inside voice rooms today; the plugin SDK turns your ideas into the next one.',
    },
    {
      icon: 'extension',
      iconColor: 'text-ember',
      title: 'Open ecosystem',
      body: 'A reviewed marketplace for community plugins — artifact hashes pin the exact bytes you install.',
    },
  ];
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <h2 className="font-display font-bold text-[32px] md:text-[44px] leading-tight tracking-tight text-text-primary mb-4">
        Built around the room.
      </h2>
      <p className="font-body-lg text-body-lg text-text-secondary mb-12 max-w-2xl">
        Everything LobbyForge does serves the room where your community actually talks.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {values.map((v) => (
          <div
            key={v.title}
            className="bg-surface/80 backdrop-blur-sm rounded-2xl border border-border-subtle/30 p-8 flex flex-col gap-4"
          >
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined ${v.iconColor}`}>{v.icon}</span>
              <h3 className="font-display font-bold text-xl text-text-primary">{v.title}</h3>
            </div>
            <p className="text-text-secondary text-sm leading-relaxed">{v.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SelfHost() {
  const steps = [
    {
      title: 'Clone a tagged release',
      body: 'git clone --branch <release-tag> — the installer needs the repo files next to it.',
    },
    {
      title: 'Run the installer',
      body: 'bash install.sh — it asks for your domain, generates secrets and provisions TLS.',
    },
    {
      title: 'Complete first-run setup',
      body: 'Open your domain, walk the setup wizard, remove the setup token from .env.prod.',
    },
    {
      title: 'Invite your community',
      body: 'Share an invite link — guests join a voice room with one click, no account needed.',
    },
  ];
  return (
    <section id="self-host" className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <div className="rounded-2xl border border-border-subtle/40 bg-surface/60 p-8 md:p-12 flex flex-col gap-10">
        <div>
          <p className="font-label-xs text-label-xs text-ember tracking-[0.2em] uppercase mb-4">
            Host your own
          </p>
          <h2 className="font-display font-bold text-[32px] md:text-[44px] leading-tight tracking-tight text-text-primary mb-4">
            Yours in an afternoon.
          </h2>
          <p className="text-text-secondary text-sm leading-relaxed">
            What it really takes: a Linux VPS with Docker, a domain, and 2–4 GB of RAM. Let&apos;s
            Encrypt by default — behind Cloudflare with an Origin certificate instead?{' '}
            <a
              href={`${REPO}/blob/main/docs/DEPLOY_CLOUDFLARE.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
            >
              Read the Cloudflare guide
            </a>
            .
          </p>
        </div>
        <ol className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-2">
              <span className="font-display font-bold text-ember text-lg">{i + 1}</span>
              <h3 className="font-label-sm text-label-sm text-text-primary">{step.title}</h3>
              <p className="text-text-muted text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
        <a
          href={`${REPO}#install`}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start border border-border-strong text-text-secondary px-6 py-3 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all"
        >
          View the installation guide
        </a>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full text-center py-section-gap">
      <h2 className="font-display font-bold text-[32px] md:text-[44px] leading-tight tracking-tight text-text-primary mb-8 max-w-3xl mx-auto text-balance">
        A voice platform for communities that want ownership.
      </h2>
      <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
        <a
          href="/discover"
          className="w-full sm:w-auto bg-primary-container text-on-primary-container px-8 py-4 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all"
        >
          Explore communities
        </a>
        <a
          href="#self-host"
          className="w-full sm:w-auto border border-border-strong text-text-secondary px-8 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 hover:text-text-primary transition-all"
        >
          Host LobbyForge
        </a>
      </div>
    </section>
  );
}


// Star count via the GitHub API, cached for an hour. Falls back to a
// plain link when the API is unreachable (rate limits/offline).
async function GitHubStars() {
    try {
    const res = await fetch('https://api.github.com/repos/Juanka-e/LobbyForge', {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    if (typeof data.stargazers_count !== 'number') return null;
    return <span className="ml-1 rounded-full bg-surface-variant/60 px-2 py-0.5 text-xs text-text-secondary">{data.stargazers_count}</span>;
  } catch {
    return null;
  }
}
