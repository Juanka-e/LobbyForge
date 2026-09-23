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
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';

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
  const t = useT();
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
      setError(t('auth.connect.invalidAddress'));
      return;
    }
    setError(null);
    remember(host);
    window.open(`https://${host}/login`, '_blank', 'noopener');
  }

  // Both sentences carry markup in the middle (a link, a code span); split
  // each whole phrase around its placeholder so word order can differ.

  return (
    <section className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full flex flex-col items-center pt-8">
      <div className="w-full max-w-xl flex flex-col gap-8">
        <div className="text-center flex flex-col gap-4">
          <h1 className="font-display font-bold text-[36px] sm:text-[44px] leading-tight tracking-tight text-text-primary text-balance">
            {t('auth.connect.title')}
          </h1>
          <p className="font-body-lg text-body-lg text-text-secondary text-pretty">
            {t('auth.connect.subtitle')}
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
            {t('auth.connect.addressLabel')}
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
            {t('auth.connect.continue')}
          </button>
        </form>
        {error ? (
          <p id="instance-url-error" role="alert" className="text-sm text-ember -mt-4">
            {error}
          </p>
        ) : null}

        <p className="text-sm text-text-muted leading-relaxed text-center">
          {t('auth.connect.signInElsewhere')}
        </p>

        {recent.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h2 className="font-label-xs text-label-xs text-text-muted tracking-[0.15em] uppercase">
              {t('auth.connect.recent')}
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
                    aria-label={t('auth.connect.removeRecent', { host })}
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
            {rich(t('auth.connect.empty'), {
              link: (
                <a href="/discover" className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
                  {t('auth.connect.emptyLink')}
                </a>
              ),
            })}
          </p>
        )}

        <p className="text-sm text-text-muted text-center">
          {rich(t('auth.connect.desktopHint'), { scheme: <span className="font-mono">lobbyforge://</span> })}
        </p>
      </div>
    </section>
  );
}
