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
import { useT } from '@/lib/i18n/client';

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
  const t = useT();
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
            setMetaError(t('auth.join.unknownCode'));
          } else {
            const detail = await res.json().catch(() => ({}));
            setMetaError(t('auth.join.loadFailed', { detail: JSON.stringify(detail) }));
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
  }, [code, t]);

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
      setStatus({ kind: 'ok', message: t('auth.join.signedInAs', { name: data.guest.name }) });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [code, t]);

  const acceptInvite = useCallback(async () => {
    if (!code) return;
    if (!guest) {
      setStatus({ kind: 'error', message: t('auth.join.signInFirstError') });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/redeem`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        setStatus({ kind: 'error', message: t('auth.join.sessionExpired') });
        return;
      }
      if (res.status === 409) {
        setStatus({ kind: 'error', message: t('auth.join.alreadyMember') });
        return;
      }
      if (res.status === 410) {
        const detail = (await res.json().catch(() => ({}))) as RedeemResponse;
        setStatus({ kind: 'error', message: detail.error ?? t('auth.join.noLongerValid') });
        return;
      }
      if (res.status === 404) {
        setStatus({ kind: 'error', message: t('auth.join.revoked') });
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as RedeemResponse;
        throw new Error(`redeem → ${res.status} ${detail.error ?? ''}`);
      }
      const data = (await res.json()) as RedeemResponse;
      if (data.membership) {
        setJoinedServerId(data.membership.serverId);
        setStatus({
          kind: 'ok',
          message: meta?.serverName
            ? t('auth.join.joined', { name: meta.serverName })
            : t('auth.join.joinedUnnamed'),
        });
      } else {
        setStatus({ kind: 'error', message: t('auth.join.noMembership') });
      }
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [code, guest, meta?.serverName, t]);

  const inviteUnusable =
    !meta || meta.isExpired || meta.isExhausted || metaError !== null;

  // "server · 3/10 uses · expires …" — a list of facts, so the parts are
  // separate strings; each part is a whole phrase in the catalogue.
  const inviteSummary = meta
    ? [
        meta.serverName,
        meta.maxUses === null
          ? t('auth.join.usesUnlimited')
          : t('auth.join.usesCount', { current: meta.currentUses, max: meta.maxUses }),
        meta.expiresAt
          ? t('auth.join.expires', { date: new Date(meta.expiresAt).toLocaleString(t.locale) })
          : t('auth.join.noExpiry'),
      ].join(' · ') +
      (meta.isExpired ? ` ${t('auth.join.expiredFlag')}` : '') +
      (meta.isExhausted ? ` ${t('auth.join.exhaustedFlag')}` : '')
    : t('common.loading');

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>{t('auth.join.title')}</h1>
      <p style={{ color: '#9aa3ad' }}>{t('auth.join.intro')}</p>

      <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
        <Step
          step={1}
          title={t('auth.join.detailsTitle')}
          description={metaError || inviteSummary}
        />
        <Step
          step={2}
          title={t('auth.join.signInAsGuest')}
          description={
            guest
              ? t(guest.uid ? 'auth.join.guestActive' : 'auth.join.guestActivePending', {
                  name: guest.name,
                  gid: guest.gid,
                })
              : t('auth.join.noGuest')
          }
          actions={
            <button onClick={createGuest} disabled={status.kind === 'busy'}>
              {guest ? t('auth.join.recreateGuest') : t('auth.join.signInAsGuest')}
            </button>
          }
        />
        <Step
          step={3}
          title={t('auth.join.accept')}
          description={
            joinedServerId
              ? meta?.serverName
                ? t('auth.join.memberOf', { name: meta.serverName })
                : t('auth.join.memberOfUnnamed')
              : t('auth.join.signInFirst')
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
                {t('auth.join.openServer')}
              </a>
            ) : (
              <button
                onClick={acceptInvite}
                disabled={status.kind === 'busy' || !guest || inviteUnusable}
              >
                {t('auth.join.accept')}
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
  const t = useT();
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
          {t('auth.join.stepHeading', { step: props.step, title: props.title })}
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
