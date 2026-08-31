import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';

export const metadata: Metadata = {
  title: 'LobbyForge — Build the voice community you control',
  description:
    'LobbyForge is an open-source platform for self-hosted voice rooms, built-in games, bots, and public discovery.',
};

export default function LandingPage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  return (
    <>
      <Hero />
      <FeatureStrip />
      <ProductPreview />
      <FinalCta />
    </>
  );
}

function Hero() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full text-center">
      <h1 className="font-hero-h1-mobile md:font-hero-h1 text-hero-h1-mobile md:text-hero-h1 text-text-primary mb-6 max-w-4xl mx-auto">
        Build the voice community you control.
      </h1>
      <p className="font-body-lg text-body-lg text-text-secondary max-w-2xl mx-auto mb-10">
        LobbyForge is an open-source platform for self-hosted voice rooms, built-in games, bots, and
        public discovery.
      </p>
      <div className="flex flex-col sm:flex-row justify-center items-center gap-4 mb-12">
        <a
          href="/lobby"
          className="w-full sm:w-auto bg-primary-container text-[#07101E] px-8 py-4 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all"
        >
          Explore LobbyForge
        </a>
        <a
          href="#self-host"
          className="w-full sm:w-auto border border-border-strong text-secondary px-8 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 transition-all"
        >
          View self-host setup
        </a>
        <a
          href="https://github.com/Juanka-e/LobbyForge"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full sm:w-auto flex items-center justify-center gap-2 border border-border-strong text-text-primary px-6 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 transition-all"
        >
          {/* GitHub mark (public domain shape) */}
          <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          Star on GitHub
          <GitHubStars />
        </a>
      </div>
      <p className="font-label-sm text-label-sm text-text-muted mb-16 tracking-widest uppercase">
        Open source • Self-hosted • Voice rooms • Built-in games
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
              <button className="bg-[#E7B86A] text-[#07101E] px-4 py-1.5 rounded font-bold text-label-xs hover:brightness-110 transition-all">
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

function FeatureStrip() {
  const features = [
    { icon: 'dns', label: 'Own your instance', colorClass: 'text-primary' },
    { icon: 'record_voice_over', label: 'Voice rooms and chat', colorClass: 'text-primary' },
    { icon: 'sports_esports', label: 'Games inside rooms', colorClass: 'text-[#E7B86A]' },
    { icon: 'public', label: 'Public discovery optional', colorClass: 'text-primary' },
  ];
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-8 py-8 border-y border-border-subtle/30">
        {features.map((f) => (
          <div key={f.label} className="flex flex-col items-center text-center gap-3">
            <span className={`material-symbols-outlined ${f.colorClass} text-3xl font-light`}>
              {f.icon}
            </span>
            <h3 className="font-label-sm text-label-sm text-text-primary">{f.label}</h3>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProductPreview() {
  const cards = [
    {
      icon: 'record_voice_over',
      iconColor: 'text-primary',
      title: 'Voice room + chat',
      body: 'Persistent text channels integrated natively with low-latency voice rooms.',
    },
    {
      icon: 'sports_esports',
      iconColor: 'text-[#E7B86A]',
      title: 'Start Activity / Hushle',
      body: 'Launch built-in games and activities directly within the room with one click.',
    },
    {
      icon: 'smart_toy',
      iconColor: 'text-primary',
      title: 'Bots and roles',
      body: 'Powerful permission systems and bot integrations to moderate and manage your community.',
    },
    {
      icon: 'health_and_safety',
      iconColor: 'text-primary',
      title: 'Doctor health checks',
      body: 'Real-time diagnostics and performance monitoring for your self-hosted instance.',
    },
  ];
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
      <h2 className="font-section-h2-mobile md:font-section-h2 text-section-h2-mobile md:text-section-h2 text-text-primary mb-12 text-center">
        Built for communities.
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {cards.map((c) => (
          <div
            key={c.title}
            className="bg-surface/80 backdrop-blur-sm rounded-2xl border border-border-subtle/30 p-8 flex flex-col gap-4 shadow-mockup"
          >
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined ${c.iconColor}`}>{c.icon}</span>
              <h3 className="font-body-lg text-body-lg font-semibold text-text-primary">
                {c.title}
              </h3>
            </div>
            <p className="text-text-secondary text-sm">{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full text-center py-section-gap">
      <h2 className="font-section-h2-mobile md:font-section-h2 text-section-h2-mobile md:text-section-h2 text-text-primary mb-8 max-w-3xl mx-auto">
        A voice platform for communities that want ownership.
      </h2>
      <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
        <a
          href="/lobby"
          className="w-full sm:w-auto bg-primary-container text-[#07101E] px-8 py-4 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all"
        >
          Explore LobbyForge
        </a>
        <a
          href="#"
          className="w-full sm:w-auto border border-border-strong text-secondary px-8 py-4 rounded-lg font-label-sm text-label-sm hover:bg-surface-variant/30 transition-all"
        >
          Read the docs
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
