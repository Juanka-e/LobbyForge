/**
 * Invite-redeem landing page.
 *
 * Flow:
 *   1. Mount → GET /api/invites/{code} (public metadata endpoint) to show
 *      the server name + invite status.
 *   2. "Sign in as guest" → POST /api/auth/guest (idempotent: rebinds if a
 *      cookie already exists, mints a new identity otherwise).
 *   3. "Accept invite" → POST /api/invites/{code}/redeem. On 201 we redirect
 *      to /servers/{serverId}; the server-home page itself is M15 UI, so
 *      for now the success state is a "you're in" toast with a manual link.
 *
 * No PII is rendered here — only the server's display name + invite meta.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type InviteMeta = {
  code: string;
  serverId: string;
  serverName: string;
  expiresAt: string | null;
  currentUses: number;
  maxUses: number | null;
  isExpired: boolean;
  isExhausted: boolean;
};

type Guest = { gid: string; uid: string | null; name: string };

type RedeemResponse = {
  membership?: { serverId: string; userId: string; roleId: string };
  error?: string;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; message: string };

export default function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const [code, setCode] = useState<string | null>(null);
  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [joinedServerId, setJoinedServerId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Unwrap the dynamic route param on mount. Next 15 ships `params` as a
  // Promise; we resolve it once and store the result.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await params;
      if (!cancelled) setCode(resolved.code);
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  // Once we have the code, fetch the public metadata. This is the only
  // request the page issues that does NOT need a session cookie.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void (async () => {
      setStatus({ kind: 'busy' });
      try {
        const res = await fetch(`/api/invites/${encodeURIComponent(code)}`, {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          if (res.status === 404) {
            setMetaError('This invite code is unknown or has been revoked.');
          } else {
            const detail = await res.json().catch(() => ({}));
            setMetaError(`Failed to load invite: ${JSON.stringify(detail)}`);
          }
          setStatus({ kind: 'idle' });
          return;
        }
        const data = (await res.json()) as { invite: InviteMeta };
        if (cancelled) return;
        setMeta(data.invite);
        setStatus({ kind: 'idle' });
      } catch (err) {
        if (cancelled) return;
        setMetaError((err as Error).message);
        setStatus({ kind: 'idle' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Probe an existing session so a returning visitor skips the guest step.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/guest', { method: 'GET', credentials: 'same-origin' });
        if (res.status === 401) return;
        if (!res.ok) return;
        const data = (await res.json()) as { guest: Guest };
        setGuest(data.guest);
      } catch {
        // Silent — guest is optional until the user clicks "Accept".
      }
    })();
  }, []);

  const createGuest = useCallback(async () => {
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: code }),
      });
      if (!res.ok) throw new Error(`POST /api/auth/guest → ${res.status}`);
      const data = (await res.json()) as { guest: Guest };
      setGuest(data.guest);
      setStatus({ kind: 'ok', message: `Signed in as ${data.guest.name}` });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [code]);

  const acceptInvite = useCallback(async () => {
    if (!code) return;
    if (!guest) {
      setStatus({ kind: 'error', message: 'Sign in as a guest first.' });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/redeem`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Your session expired. Click "Sign in as guest" again.' });
        return;
      }
      if (res.status === 409) {
        setStatus({ kind: 'error', message: 'You are already a member of this server.' });
        return;
      }
      if (res.status === 410) {
        const detail = (await res.json().catch(() => ({}))) as RedeemResponse;
        setStatus({ kind: 'error', message: detail.error ?? 'This invite is no longer valid.' });
        return;
      }
      if (res.status === 404) {
        setStatus({ kind: 'error', message: 'This invite was revoked.' });
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as RedeemResponse;
        throw new Error(`redeem → ${res.status} ${detail.error ?? ''}`);
      }
      const data = (await res.json()) as RedeemResponse;
      if (data.membership) {
        setJoinedServerId(data.membership.serverId);
        setStatus({ kind: 'ok', message: `Joined ${meta?.serverName ?? 'server'}.` });
      } else {
        setStatus({ kind: 'error', message: 'Redeem succeeded but returned no membership.' });
      }
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [code, guest, meta?.serverName]);

  const inviteUnusable =
    !meta || meta.isExpired || meta.isExhausted || metaError !== null;

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Join a server</h1>
      <p style={{ color: '#9aa3ad' }}>
        You&apos;ve been invited to join a LobbyForge server. Sign in as a guest, then
        accept the invite to be added to the server&apos;s @everyone role.
      </p>

      <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
        <Step
          step={1}
          title="Invite details"
          description={
            metaError
              ? metaError
              : meta
                ? `${meta.serverName} · ${meta.maxUses === null ? 'unlimited uses' : `${meta.currentUses}/${meta.maxUses} uses`}${
                    meta.expiresAt
                      ? ` · expires ${new Date(meta.expiresAt).toLocaleString()}`
                      : ' · no expiry'
                  }${meta.isExpired ? ' (EXPIRED)' : ''}${meta.isExhausted ? ' (EXHAUSTED)' : ''}`
                : 'Loading…'
          }
        />
        <Step
          step={2}
          title="Sign in as guest"
          description={
            guest
              ? `Active: ${guest.name} (${guest.gid})${guest.uid ? '' : ' — materializing…'}`
              : 'No active guest session. Click to create one.'
          }
          actions={
            <button onClick={createGuest} disabled={status.kind === 'busy'}>
              {guest ? 'Recreate guest' : 'Sign in as guest'}
            </button>
          }
        />
        <Step
          step={3}
          title="Accept invite"
          description={
            joinedServerId
              ? `You are now a member of ${meta?.serverName ?? 'the server'}.`
              : 'Sign in first, then click to join the server.'
          }
          actions={
            joinedServerId ? (
              <a
                href={`/servers/${joinedServerId}`}
                style={{
                  color: '#5ad48a',
                  textDecoration: 'underline',
                }}
              >
                Open server (M15 UI placeholder)
              </a>
            ) : (
              <button
                onClick={acceptInvite}
                disabled={status.kind === 'busy' || !guest || inviteUnusable}
              >
                Accept invite
              </button>
            )
          }
        />
      </div>

      <StatusLine status={status} />
    </section>
  );
}

function Step(props: { step: number; title: string; description: string; actions?: React.ReactNode }) {
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
        <strong style={{ fontSize: 18 }}>
          Step {props.step}: {props.title}
        </strong>
      </div>
      <p style={{ color: '#9aa3ad', margin: '8px 0' }}>{props.description}</p>
      {props.actions ? <div style={{ display: 'flex', gap: 8 }}>{props.actions}</div> : null}
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const color =
    status.kind === 'busy' ? '#9aa3ad' : status.kind === 'error' ? '#e36049' : '#5ad48a';
  return <p style={{ color, marginTop: 16 }}>{status.kind === 'busy' ? '…' : status.message}</p>;
}
