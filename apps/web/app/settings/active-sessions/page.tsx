'use client';

import { useCallback, useEffect, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';

/**
 * User Settings -> Active Sessions.
 *
 * Lists every browser/device that has an active session for this
 * account. Each row shows the IP address, browser, OS, device type,
 * optional location (from trusted proxy geo-headers), and when the
 * session was last seen. The current session is highlighted and
 * cannot be revoked here (use Sign Out instead).
 *
 * Data comes from Redis session fingerprints recorded by the auth
 * flow. Sessions auto-expire after 7 days of inactivity.
 */

interface SessionFingerprint {
  gid: string;
  ipAddress: string;
  browser: string;
  os: string;
  deviceType: string;
  location: string;
  createdAt: number;
  lastSeen: number;
}

function timeAgo(ts: number, t: Translator): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('settings.sessions.time.justNow');
  if (diff < 3600_000) return t('settings.sessions.time.minutes', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('settings.sessions.time.hours', { count: Math.floor(diff / 3600_000) });
  return t('settings.sessions.time.days', { count: Math.floor(diff / 86_400_000) });
}

/**
 * Browser and OS names are data (Chrome, Windows) — except the parser's
 * own 'Unknown', and the device classes it picks from a fixed set.
 */
function parsedName(value: string, t: Translator): string {
  return value === 'Unknown' ? t('settings.sessions.unknown') : value;
}

function deviceTypeLabel(deviceType: string, t: Translator): string {
  if (deviceType === 'Desktop') return t('settings.sessions.device.desktop');
  if (deviceType === 'Mobile') return t('settings.sessions.device.mobile');
  if (deviceType === 'Tablet') return t('settings.sessions.device.tablet');
  return deviceType;
}

function browserOnOs(session: SessionFingerprint, t: Translator): string {
  return t('settings.sessions.browserOnOs', {
    browser: parsedName(session.browser, t),
    os: parsedName(session.os, t),
  });
}

function deviceIcon(deviceType: string): string {
  if (deviceType === 'Mobile') return 'smartphone';
  if (deviceType === 'Tablet') return 'tablet';
  return 'computer';
}

export default function ActiveSessionsPage() {
  const t = useT();
  const [sessions, setSessions] = useState<SessionFingerprint[]>([]);
  const [currentGid, setCurrentGid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Get the current session's gid from the guest endpoint
      const guestRes = await fetch('/api/auth/guest', { credentials: 'same-origin' });
      if (guestRes.ok) {
        const guest = (await guestRes.json()) as { guest?: { gid?: string } };
        if (guest.guest?.gid) setCurrentGid(guest.guest.gid);
      }
      const res = await fetch('/api/settings/me/sessions', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionFingerprint[] };
      setSessions(data.sessions);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(gid: string) {
    setBusy(gid);
    try {
      const res = await fetch('/api/settings/me/sessions', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', gid }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const otherSessions = sessions.filter((s) => s.gid !== currentGid);
  const currentSession = sessions.find((s) => s.gid === currentGid);

  return (
    <SettingsShell scope="user">
      <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.sessions')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('settings.sessions.description')}</p>
        </header>

        {/* Current session */}
        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
            {t('settings.sessions.thisDevice')}
          </h2>
          <div className="rounded-xl bg-surface border border-border-subtle p-5 flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center border border-success/30 flex-shrink-0">
              <span className="material-symbols-outlined text-success">
                {currentSession ? deviceIcon(currentSession.deviceType) : 'computer'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-text-primary font-medium">
                  {currentSession ? browserOnOs(currentSession, t) : t('settings.sessions.thisBrowser')}
                </p>
                <span className="px-2 py-0.5 rounded-full bg-success/15 text-success text-[10px] uppercase tracking-wider font-bold">
                  {t('settings.sessions.activeNow')}
                </span>
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {ipLabel(currentSession?.ipAddress, t)}
                {currentSession?.location ? ` - ${currentSession.location}` : ''}
                {' - '}
                {currentSession ? timeAgo(currentSession.lastSeen, t) : ''}
              </p>
            </div>
          </div>
        </section>

        {/* Other sessions */}
        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
            {otherSessions.length > 0
              ? t('settings.sessions.othersCount', { count: otherSessions.length })
              : t('settings.sessions.others')}
          </h2>
          <div className="rounded-xl bg-surface border border-border-subtle divide-y divide-border-subtle/50">
            {loading ? (
              <div className="p-6 text-sm text-text-muted">{t('common.loading')}</div>
            ) : otherSessions.length === 0 ? (
              <div className="p-6 flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-text-muted">check_circle</span>
                </div>
                <p className="text-sm text-text-secondary">{t('settings.sessions.empty')}</p>
              </div>
            ) : (
              otherSessions.map((s) => (
                <div key={s.gid} className="p-5 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center border border-border-subtle flex-shrink-0">
                    <span className="material-symbols-outlined text-text-secondary">{deviceIcon(s.deviceType)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary font-medium">
                      {browserOnOs(s, t)}
                      <span className="text-text-muted font-normal ml-2">- {deviceTypeLabel(s.deviceType, t)}</span>
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {ipLabel(s.ipAddress, t)}
                      {s.location ? ` - ${s.location}` : ''}
                      {' - '}
                      {t('settings.sessions.lastSeen', { time: timeAgo(s.lastSeen, t) })}
                    </p>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      {t('settings.sessions.firstSeen', { time: timeAgo(s.createdAt, t) })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(s.gid)}
                    disabled={busy === s.gid}
                    className="px-3 py-1.5 rounded-md border border-danger/40 text-xs text-danger hover:bg-danger/10 transition-colors flex-shrink-0 disabled:opacity-40"
                  >
                    {busy === s.gid ? t('settings.sessions.revoking') : t('settings.sessions.revoke')}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">shield</span>
          <p className="text-xs text-text-muted leading-relaxed">{t('settings.sessions.note')}</p>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </SettingsShell>
  );
}

/** The session tracker stores 'unknown' when no client IP could be read. */
function ipLabel(ip: string | null | undefined, t: Translator): string {
  return !ip || ip === 'unknown' ? t('settings.sessions.unknownIp') : ip;
}
