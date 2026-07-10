'use client';

import { useCallback, useEffect, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';

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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function deviceIcon(deviceType: string): string {
  if (deviceType === 'Mobile') return 'smartphone';
  if (deviceType === 'Tablet') return 'tablet';
  return 'computer';
}

export default function ActiveSessionsPage() {
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
          <h1 className="text-2xl font-semibold text-text-primary">Active Sessions</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Every device currently signed in to your account. Revoke anything you don&apos;t recognize.
            Sessions auto-expire after 7 days of inactivity.
          </p>
        </header>

        {/* Current session */}
        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
            This Device
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
                  {currentSession ? `${currentSession.browser} on ${currentSession.os}` : 'This browser'}
                </p>
                <span className="px-2 py-0.5 rounded-full bg-success/15 text-success text-[10px] uppercase tracking-wider font-bold">
                  Active now
                </span>
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {currentSession?.ipAddress ?? 'unknown IP'}
                {currentSession?.location ? ` - ${currentSession.location}` : ''}
                {' - '}
                {currentSession ? timeAgo(currentSession.lastSeen) : ''}
              </p>
            </div>
          </div>
        </section>

        {/* Other sessions */}
        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
            Other Sessions {otherSessions.length > 0 ? `(${otherSessions.length})` : ''}
          </h2>
          <div className="rounded-xl bg-surface border border-border-subtle divide-y divide-border-subtle/50">
            {loading ? (
              <div className="p-6 text-sm text-text-muted">Loading...</div>
            ) : otherSessions.length === 0 ? (
              <div className="p-6 flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-text-muted">check_circle</span>
                </div>
                <p className="text-sm text-text-secondary">
                  No other active sessions. If someone else signs in to your account from another
                  device, they will appear here.
                </p>
              </div>
            ) : (
              otherSessions.map((s) => (
                <div key={s.gid} className="p-5 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center border border-border-subtle flex-shrink-0">
                    <span className="material-symbols-outlined text-text-secondary">{deviceIcon(s.deviceType)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary font-medium">
                      {s.browser} on {s.os}
                      <span className="text-text-muted font-normal ml-2">- {s.deviceType}</span>
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {s.ipAddress}
                      {s.location ? ` - ${s.location}` : ''}
                      {' - last seen '}
                      {timeAgo(s.lastSeen)}
                    </p>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      First seen {timeAgo(s.createdAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(s.gid)}
                    disabled={busy === s.gid}
                    className="px-3 py-1.5 rounded-md border border-danger/40 text-xs text-danger hover:bg-danger/10 transition-colors flex-shrink-0 disabled:opacity-40"
                  >
                    {busy === s.gid ? 'Revoking...' : 'Revoke'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">shield</span>
          <p className="text-xs text-text-muted leading-relaxed">
            If you see a session you don&apos;t recognize, revoke it immediately and change your
            password. Session fingerprints are stored in Redis and expire automatically after 7 days
            of inactivity - no manual cleanup needed.
          </p>
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

