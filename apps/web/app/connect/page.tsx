/**
 * Product Connect page — the front door for "I have an instance URL".
 *
 * Per ADR-006 the hub has NO accounts: you enter a community's address
 * and sign in ON THAT COMMUNITY'S OWN SITE. This page never handles
 * credentials.
 *
 * (The phase-1 guest/LiveKit walkthrough this route used to host lives
 * on at /connect/demo — the dev e2e specs still exercise it.)
 */
'use client';

import { useEffect, useState } from 'react';

const RECENT_KEY = 'lf-recent-instances';

function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Accept bare hosts (community.example.com) or full https URLs.
  const candidate = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.hostname + (url.port ? `:${url.port}` : '');
  } catch {
    return null;
  }
}

export default function ConnectPage() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw).filter((h: unknown) => typeof h === 'string').slice(0, 5));
    } catch {
      // localStorage unavailable/blocked — recents are cosmetic, ignore.
    }
  }, []);

  function remember(host: string) {
    setRecent((prev) => {
      const next = [host, ...prev.filter((h) => h !== host)].slice(0, 5);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  function connect(rawInput: string) {
    const host = normalizeHost(rawInput);
    if (!host) {
      setError('Enter a valid community address, e.g. community.example.com');
      return;
    }
    setError(null);
    remember(host);
    window.open(`https://${host}/login`, '_blank', 'noopener');
  }

  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full flex flex-col items-center pt-8">
      <div className="w-full max-w-xl flex flex-col gap-8">
        <div className="text-center flex flex-col gap-4">
          <h1 className="font-display font-bold text-[36px] sm:text-[44px] leading-tight tracking-tight text-text-primary text-balance">
            Connect to a LobbyForge community
          </h1>
          <p className="font-body-lg text-body-lg text-text-secondary text-pretty">
            Enter the address of the community you want to join.
          </p>
        </div>

        <form
          className="flex flex-col sm:flex-row gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            connect(value);
          }}
        >
          <label htmlFor="instance-url" className="sr-only">
            Community address
          </label>
          <input
            id="instance-url"
            name="instance-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="community.example.com"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'instance-url-error' : undefined}
            className="auth-input flex-grow font-mono"
          />
          <button
            type="submit"
            className="bg-primary-container text-on-primary-container px-8 py-2.5 rounded-lg font-label-sm text-label-sm hover:brightness-110 transition-all shrink-0"
          >
            Continue
          </button>
        </form>
        {error ? (
          <p id="instance-url-error" role="alert" className="text-sm text-ember -mt-4">
            {error}
          </p>
        ) : null}

        <p className="text-sm text-text-muted leading-relaxed text-center">
          You&apos;ll sign in on the community&apos;s own site — LobbyForge has no central account.
        </p>

        {recent.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h2 className="font-label-xs text-label-xs text-text-muted tracking-[0.15em] uppercase">
              Recent communities
            </h2>
            <ul className="flex flex-col gap-2">
              {recent.map((host) => (
                <li key={host} className="flex items-center gap-2 bg-surface-raised border border-border-subtle rounded-lg px-4 py-3">
                  <button
                    type="button"
                    onClick={() => connect(host)}
                    className="flex-grow text-left text-text-primary font-mono text-sm hover:text-primary transition-colors truncate"
                  >
                    {host}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${host} from recent communities`}
                    onClick={() => {
                      setRecent((prev) => {
                        const next = prev.filter((h) => h !== host);
                        try {
                          window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
                        } catch {
                          // ignore
                        }
                        return next;
                      });
                    }}
                    className="material-symbols-outlined text-text-muted hover:text-text-primary transition-colors text-lg"
                  >
                    close
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-text-muted text-center">
            No communities yet —{' '}
            <a href="/discover" className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
              browse the directory
            </a>{' '}
            or connect by address above.
          </p>
        )}

        <p className="text-sm text-text-muted text-center">
          Using the desktop app? It accepts <span className="font-mono">lobbyforge://</span> links
          from any instance.
        </p>
      </div>
    </section>
  );
}
