/**
 * Client-side "Connect" demo. Walks a fresh visitor through the M9 flow:
 *   1. POST /api/auth/guest     → sets lf_guest cookie, returns the identity
 *   2. POST /api/livekit/token  → exchanges the cookie for a LiveKit JWT
 *   3. The token + identity are then used by the LiveKit client SDK
 *      (added in a later pass) to actually connect to a room.
 *
 * This page is intentionally a thin shell — it exists to make the "two
 * browsers in the same room" success criterion from Phase 1 of the roadmap
 * verifiable end-to-end without a custom UI framework. Once the real
 * voice-room UI lands, this page is removed.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Guest = { gid: string; name: string; ttlSeconds?: number; iat?: number; exp?: number };
type Token = { token: string; identity: string; room: string; ttlSeconds: number; expiresAt: number };
type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; message: string };

export default function ConnectPage() {
  const [guest, setGuest] = useState<Guest | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [serverId, setServerId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Probe the current session on mount so a returning visitor sees their gid.
  useEffect(() => {
    void refreshGuest();
  }, []);

  const refreshGuest = useCallback(async () => {
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/api/auth/guest', { method: 'GET', credentials: 'same-origin' });
      if (res.status === 401) {
        setGuest(null);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!res.ok) throw new Error(`GET /api/auth/guest → ${res.status}`);
      const data = (await res.json()) as { guest: Guest };
      setGuest(data.guest);
      setStatus({ kind: 'ok', message: `Existing session for ${data.guest.name}` });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  const createGuest = useCallback(async () => {
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`POST /api/auth/guest → ${res.status}`);
      const data = (await res.json()) as { guest: Guest };
      setGuest(data.guest);
      setStatus({ kind: 'ok', message: `Created guest ${data.guest.name}` });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  const getToken = useCallback(async () => {
    if (!guest) {
      setStatus({ kind: 'error', message: 'Create a guest first.' });
      return;
    }
    if (!serverId || !channelId) {
      setStatus({ kind: 'error', message: 'Server id and channel id are required.' });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/api/livekit/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, channelId }),
      });
      if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Session expired. Click "Create guest" again.' });
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(`POST /api/livekit/token → ${res.status} ${JSON.stringify(detail)}`);
      }
      const data = (await res.json()) as Token;
      setToken(data);
      setStatus({ kind: 'ok', message: `Token issued for room "${data.room}", identity ${data.identity}` });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [guest, serverId, channelId]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Connect (developer surface)</h1>
      <p style={{ color: '#9aa3ad' }}>
        Step 1 creates a guest session cookie. Step 2 exchanges that cookie for a LiveKit access token
        for the room you specify. Open this page in two browsers (or one normal + one incognito) to
        verify the two-browser voice test from the roadmap.
      </p>

      <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
        <Step
          step={1}
          title="Guest session"
          description={guest ? `Active: ${guest.name} (${guest.gid})` : 'No active guest session.'}
          actions={
            <>
              <button onClick={createGuest} disabled={status.kind === 'busy'}>
                {guest ? 'Recreate guest' : 'Create guest'}
              </button>
              <button onClick={refreshGuest} disabled={status.kind === 'busy'}>
                Refresh
              </button>
            </>
          }
        />
        <Step
          step={2}
          title="LiveKit token"
          description={
            token
              ? `Issued for room "${token.room}", identity ${token.identity}, ttl ${token.ttlSeconds}s.`
              : 'Enter a server id and voice channel id, then click "Get token".'
          }
          actions={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                placeholder="server uuid"
                style={{
                  padding: '6px 8px',
                  background: '#0f1115',
                  color: '#e6e8eb',
                  border: '1px solid #1f242c',
                  borderRadius: 4,
                }}
              />
              <input
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="voice channel uuid"
                style={{
                  padding: '6px 8px',
                  background: '#0f1115',
                  color: '#e6e8eb',
                  border: '1px solid #1f242c',
                  borderRadius: 4,
                }}
              />
              <button onClick={getToken} disabled={status.kind === 'busy'}>
                Get token
              </button>
            </div>
          }
        />
      </div>

      <StatusLine status={status} />
      {token ? (
        <details style={{ marginTop: 16 }}>
          <summary>Show token (JWT)</summary>
          <pre
            style={{
              background: '#0a0c0f',
              padding: 12,
              borderRadius: 4,
              overflow: 'auto',
              maxWidth: 880,
            }}
          >
            {token.token}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function Step(props: { step: number; title: string; description: string; actions: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid #1f242c',
        borderRadius: 8,
        padding: 16,
        background: '#11151b',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <strong style={{ fontSize: 18 }}>Step {props.step}: {props.title}</strong>
      </div>
      <p style={{ color: '#9aa3ad', margin: '8px 0' }}>{props.description}</p>
      <div style={{ display: 'flex', gap: 8 }}>{props.actions}</div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const color =
    status.kind === 'busy' ? '#9aa3ad' : status.kind === 'error' ? '#e36049' : '#5ad48a';
  return <p style={{ color, marginTop: 16 }}>{status.kind === 'busy' ? '…' : status.message}</p>;
}
