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
 *
 * Creating a NEW guest is behind bot protection (docs/CAPTCHA.md §6): the
 * challenge shows in step 1 while there is no session.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { CaptchaField } from '@/components/captcha/CaptchaField';
import { guestFailureMessage } from '@/components/captcha/guest-failure';
import { useCaptchaGate } from '@/components/captcha/useCaptchaGate';
import { useT } from '@/lib/i18n/client';

type Guest = { gid: string; name: string; ttlSeconds?: number; iat?: number; exp?: number };
type Token = { token: string; identity: string; room: string; ttlSeconds: number; expiresAt: number };
type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'ok'; message: string };

const buttonClass =
  'rounded-md border border-border-strong px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
const inputClass =
  'min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary';

export default function ConnectPage() {
  const t = useT();
  const [guest, setGuest] = useState<Guest | null>(null);
  const [probed, setProbed] = useState(false);
  const [token, setToken] = useState<Token | null>(null);
  const [serverId, setServerId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Refreshing an existing session is never challenged; only a new guest is.
  const guestGate = useCaptchaGate({ surface: 'guest', expectChallenge: probed && !guest });
  const { submit: submitGuest } = guestGate;

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
      setStatus({ kind: 'ok', message: t('auth.connect.demo.existingSession', { name: data.guest.name }) });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    } finally {
      setProbed(true);
    }
  }, [t]);

  // Probe the current session on mount so a returning visitor sees their gid.
  useEffect(() => {
    void refreshGuest();
  }, [refreshGuest]);

  const createGuest = useCallback(async () => {
    setStatus({ kind: 'busy' });
    const result = await submitGuest((fields) =>
      fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields }),
      })
    );
    if (result.kind !== 'response') {
      setStatus({ kind: 'error', message: t(result.kind === 'blocked' ? result.messageKey : 'captcha.error.network') });
      return;
    }
    const created = result.body.guest as Guest | undefined;
    if (!result.response.ok || !created) {
      setStatus({ kind: 'error', message: guestFailureMessage(t, result.response.status, result.body) });
      return;
    }
    setGuest(created);
    setStatus({ kind: 'ok', message: t('auth.connect.demo.createdGuest', { name: created.name }) });
  }, [submitGuest, t]);

  const getToken = useCallback(async () => {
    if (!guest) {
      setStatus({ kind: 'error', message: t('auth.connect.demo.createGuestFirst') });
      return;
    }
    if (!serverId || !channelId) {
      setStatus({ kind: 'error', message: t('auth.connect.demo.idsRequired') });
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
        setStatus({ kind: 'error', message: t('auth.connect.demo.sessionExpired') });
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(`POST /api/livekit/token → ${res.status} ${JSON.stringify(detail)}`);
      }
      const data = (await res.json()) as Token;
      setToken(data);
      setStatus({
        kind: 'ok',
        message: t('auth.connect.demo.tokenIssued', { room: data.room, identity: data.identity }),
      });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [guest, serverId, channelId, t]);

  const busy = status.kind === 'busy';

  return (
    <section className="text-text-primary">
      <h1 className="mt-0 text-2xl font-semibold">{t('auth.connect.demo.title')}</h1>
      <p className="mt-2 text-text-secondary">{t('auth.connect.demo.intro')}</p>

      <div className="mt-4 grid max-w-[640px] gap-4">
        <Step
          step={1}
          title={t('auth.connect.demo.guestSession')}
          description={
            guest
              ? t('auth.connect.demo.guestActive', { name: guest.name, gid: guest.gid })
              : t('auth.connect.demo.noGuest')
          }
          extra={
            <div className="relative grid gap-2">
              <CaptchaField gate={guestGate} />
            </div>
          }
          actions={
            <>
              <button type="button" onClick={createGuest} disabled={busy} className={buttonClass}>
                {guest ? t('auth.connect.demo.recreateGuest') : t('auth.connect.demo.createGuest')}
              </button>
              <button type="button" onClick={refreshGuest} disabled={busy} className={buttonClass}>
                {t('auth.connect.demo.refresh')}
              </button>
            </>
          }
        />
        <Step
          step={2}
          title={t('auth.connect.demo.tokenTitle')}
          description={
            token
              ? t('auth.connect.demo.tokenDetails', {
                  room: token.room,
                  identity: token.identity,
                  ttl: token.ttlSeconds,
                })
              : t('auth.connect.demo.tokenHint')
          }
          actions={
            <div className="flex w-full flex-wrap items-center gap-2">
              <input
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                placeholder={t('auth.connect.demo.serverIdPlaceholder')}
                aria-label={t('auth.connect.demo.serverIdPlaceholder')}
                className={inputClass}
              />
              <input
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder={t('auth.connect.demo.channelIdPlaceholder')}
                aria-label={t('auth.connect.demo.channelIdPlaceholder')}
                className={inputClass}
              />
              <button type="button" onClick={getToken} disabled={busy} className={buttonClass}>
                {t('auth.connect.demo.getToken')}
              </button>
            </div>
          }
        />
      </div>

      <StatusLine status={status} />
      {token ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-text-secondary">{t('auth.connect.demo.showToken')}</summary>
          <pre className="mt-2 max-w-[880px] overflow-auto rounded-md border border-border-subtle bg-surface-container p-3 text-xs text-text-primary">
            {token.token}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function Step(props: { step: number; title: string; description: string; extra?: React.ReactNode; actions: React.ReactNode }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4">
      <strong className="text-lg">{t('auth.connect.demo.stepHeading', { step: props.step, title: props.title })}</strong>
      <p className="my-2 text-text-secondary">{props.description}</p>
      {props.extra}
      <div className="mt-2 flex flex-wrap gap-2">{props.actions}</div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const color = status.kind === 'busy' ? 'text-text-secondary' : status.kind === 'error' ? 'text-danger' : 'text-success';
  return (
    <p role="status" aria-live="polite" className={`mt-4 ${color}`}>
      {status.kind === 'busy' ? '…' : status.message}
    </p>
  );
}
