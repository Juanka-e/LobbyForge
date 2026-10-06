/**
 * Invite-redeem landing page.
 *
 * Flow:
 *   1. Mount → GET /api/invites/{code} (public metadata endpoint) to show
 *      the server name + invite status, and whether the server reviews new
 *      members (`requiresApproval`).
 *   2. "Sign in as guest" → POST /api/auth/guest (idempotent: rebinds if a
 *      cookie already exists, mints a new identity otherwise).
 *   3. "Accept invite" → POST /api/invites/{code}/redeem. 201 = member, with
 *      a link to /servers/{serverId}. 202 = the server holds newcomers for
 *      approval: a join request now waits for a moderator (the optional
 *      note goes with it). A signed-in visitor's existing request is read
 *      from GET /api/servers/{id}/join-requests/mine, so "waiting" and
 *      "declined" survive a reload; a waiting request can be withdrawn.
 *
 * No PII is rendered here — only the server's display name + invite meta.
 */
'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { CaptchaField } from '@/components/captcha/CaptchaField';
import { guestFailureMessage } from '@/components/captcha/guest-failure';
import { useCaptchaGate } from '@/components/captcha/useCaptchaGate';
import { useT } from '@/lib/i18n/client';
import EmailUnverifiedNotice, {
  handleEmailUnverified,
  useEmailRestriction,
} from '@/components/email-verification/EmailUnverifiedNotice';
import { REDEEM_FAILURE_KEYS, classifyRedeemFailure, failureFromInvite } from '@/lib/invite-redeem-error';

/** Same limit as the API (JOIN_REQUEST_NOTE_MAX_LENGTH). */
const NOTE_MAX_LENGTH = 500;

type InviteMeta = {
  code: string;
  serverId: string;
  serverName: string;
  expiresAt: string | null;
  currentUses: number;
  maxUses: number | null;
  isExpired: boolean;
  isExhausted: boolean;
  /** The server holds new members for a moderator's approval. */
  requiresApproval?: boolean;
};

type Guest = { gid: string; uid: string | null; name: string };

type RedeemResponse = {
  membership?: { serverId: string; userId: string; roleId: string };
  /** 202: a join request is waiting for a moderator. */
  status?: 'pending_approval';
  error?: string;
  /** `join_rejected` (403) / `join_request_limit` (429). */
  code?: string;
  retryAfter?: string;
};

/** The visitor's own join request that still matters (see the mine route). */
type JoinRequestState = { status: 'pending' } | { status: 'rejected'; retryAfter: string | null };

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; message: string };

export default function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const t = useT();
  const noteId = useId();
  const [code, setCode] = useState<string | null>(null);
  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [joinedServerId, setJoinedServerId] = useState<string | null>(null);
  const [joinRequest, setJoinRequest] = useState<JoinRequestState | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // EMAIL.md §4.2 (`join_request`): the note of a join request needs a
  // verified email in `required` mode; asking without one still works.
  const emailLock = useEmailRestriction({ enabled: Boolean(meta?.requiresApproval && guest) });
  const [noteRefused, setNoteRefused] = useState(false);
  const noteLocked = emailLock.restricted || noteRefused;
  // Whether the session probe has answered: only a visitor with no session
  // creates a NEW guest, which is what the guest surface protects.
  const [probed, setProbed] = useState(false);
  const guestGate = useCaptchaGate({ surface: 'guest', expectChallenge: probed && !guest });

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
          if (cancelled) return;
          // In words, never the response body (it used to be shown as JSON).
          setMetaError(
            t(
              res.status === 404
                ? 'auth.join.unknownCode'
                : res.status === 429
                  ? 'auth.join.error.rateLimited'
                  : 'auth.join.loadFailed'
            )
          );
          setStatus({ kind: 'idle' });
          return;
        }
        const data = (await res.json()) as { invite: InviteMeta };
        if (cancelled) return;
        setMeta(data.invite);
        setStatus({ kind: 'idle' });
      } catch {
        if (cancelled) return;
        setMetaError(t('auth.join.loadFailed'));
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
      } finally {
        setProbed(true);
      }
    })();
  }, []);

  // A signed-in visitor may already be waiting (or have been declined).
  const serverId = meta?.serverId ?? null;
  const signedInUid = guest?.uid ?? null;
  useEffect(() => {
    if (!serverId || !signedInUid) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/join-requests/mine`, {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          request: { status: 'pending' | 'rejected'; retryAfter: string | null } | null;
        };
        if (cancelled || !data.request) return;
        setJoinRequest(
          data.request.status === 'pending'
            ? { status: 'pending' }
            : { status: 'rejected', retryAfter: data.request.retryAfter }
        );
      } catch {
        // Silent — the redeem answers with the same state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, signedInUid]);

  const { submit: submitGuest } = guestGate;
  const createGuest = useCallback(async () => {
    setStatus({ kind: 'busy' });
    const result = await submitGuest((fields) =>
      fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: code, ...fields }),
      })
    );
    if (result.kind !== 'response') {
      setStatus({ kind: 'error', message: t(result.kind === 'blocked' ? result.messageKey : 'captcha.error.network') });
      return;
    }
    const guestData = result.body.guest as Guest | undefined;
    if (!result.response.ok || !guestData) {
      setStatus({ kind: 'error', message: guestFailureMessage(t, result.response.status, result.body) });
      return;
    }
    setGuest(guestData);
    setStatus({ kind: 'ok', message: t('auth.join.signedInAs', { name: guestData.name }) });
  }, [code, submitGuest, t]);

  const formatDate = useCallback((iso: string) => new Date(iso).toLocaleString(t.locale), [t.locale]);

  /**
   * A refused redeem, in words (see lib/invite-redeem-error.ts). A bare
   * 403/410 that is not a ban re-reads the invite to say whether it has
   * expired, been used up or been revoked since the page loaded — and the
   * fresh metadata disables the button for it.
   */
  const showRedeemFailure = useCallback(
    async (status: number, detail: RedeemResponse) => {
      let failure = classifyRedeemFailure(status, detail.code, detail.error);
      if (failure === 'checkInvite') {
        failure = 'generic';
        if (code) {
          try {
            const res = await fetch(`/api/invites/${encodeURIComponent(code)}`, {
              method: 'GET',
              credentials: 'same-origin',
            });
            if (res.status === 404) {
              failure = failureFromInvite(null);
              setMetaError(t('auth.join.unknownCode'));
            } else if (res.ok) {
              const data = (await res.json()) as { invite: InviteMeta };
              failure = failureFromInvite(data.invite);
              setMeta(data.invite);
            }
          } catch {
            // Could not tell which: the generic message stands.
          }
        }
      }
      setStatus({ kind: 'error', message: t(REDEEM_FAILURE_KEYS[failure]) });
    },
    [code, t]
  );

  const acceptInvite = useCallback(async () => {
    if (!code) return;
    if (!guest) {
      setStatus({ kind: 'error', message: t('auth.join.signInFirstError') });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const trimmedNote = noteLocked ? '' : note.trim();
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/redeem`, {
        method: 'POST',
        credentials: 'same-origin',
        ...(meta?.requiresApproval && trimmedNote
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: trimmedNote }) }
          : {}),
      });
      // The server reviews new members: the request now waits for a moderator.
      if (res.status === 202) {
        setJoinRequest({ status: 'pending' });
        setStatus({ kind: 'ok', message: t('auth.join.requestSent') });
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as RedeemResponse;
        // Only the note was refused: the request can be sent again without it.
        if (handleEmailUnverified(res.status, detail)) {
          setNoteRefused(true);
          setStatus({ kind: 'idle' });
          return;
        }
        if (res.status === 403 && detail.code === 'join_rejected') {
          setJoinRequest({ status: 'rejected', retryAfter: detail.retryAfter ?? null });
          setStatus({ kind: 'idle' });
          return;
        }
        // Expired, used up, revoked, banned, rate limited, session gone,
        // already a member, or a server error: each in words, no details.
        await showRedeemFailure(res.status, detail);
        return;
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
    } catch {
      // A network failure: the browser's own text ("Failed to fetch") is
      // no help to a visitor either.
      setStatus({ kind: 'error', message: t('auth.join.error.generic') });
    }
  }, [code, guest, meta?.requiresApproval, meta?.serverName, note, noteLocked, showRedeemFailure, t]);

  const cancelRequest = useCallback(async () => {
    if (!serverId) return;
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/join-requests/mine`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setStatus({ kind: 'error', message: t('auth.join.cancelFailed') });
        return;
      }
      setJoinRequest(null);
      setStatus({ kind: 'ok', message: t('auth.join.requestCancelled') });
    } catch {
      setStatus({ kind: 'error', message: t('auth.join.cancelFailed') });
    }
  }, [serverId, t]);

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

  const busy = status.kind === 'busy';
  const buttonClass =
    'rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryButtonClass =
    'rounded-md border border-border-strong px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';

  let acceptStep: { description: string; actions: React.ReactNode; extra?: React.ReactNode };
  if (joinedServerId) {
    acceptStep = {
      description: meta?.serverName ? t('auth.join.memberOf', { name: meta.serverName }) : t('auth.join.memberOfUnnamed'),
      actions: (
        <a href={`/servers/${joinedServerId}`} className="text-sm font-medium text-success underline">
          {t('auth.join.openServer')}
        </a>
      ),
    };
  } else if (joinRequest?.status === 'pending') {
    acceptStep = {
      description: t('auth.join.pending'),
      actions: (
        <button type="button" onClick={cancelRequest} disabled={busy} className={secondaryButtonClass}>
          {t('auth.join.cancelRequest')}
        </button>
      ),
    };
  } else if (joinRequest?.status === 'rejected') {
    acceptStep = {
      description: joinRequest.retryAfter
        ? t('auth.join.rejected', { date: formatDate(joinRequest.retryAfter) })
        : t('auth.join.rejectedNoDate'),
      actions: null,
    };
  } else {
    acceptStep = {
      description: meta?.requiresApproval ? t('auth.join.approvalNotice') : t('auth.join.signInFirst'),
      extra: meta?.requiresApproval ? (
        <div className="mt-2 grid gap-1">
          <label htmlFor={noteId} className="text-sm font-medium text-text-primary">
            {t('auth.join.noteLabel')}
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={NOTE_MAX_LENGTH}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            disabled={noteLocked}
            aria-describedby={noteLocked ? noteId + '-locked' : undefined}
            placeholder={t('auth.join.notePlaceholder')}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          {noteLocked ? (
            <div id={noteId + '-locked'}>
              <EmailUnverifiedNotice action="joinRequestNote" />
            </div>
          ) : null}
        </div>
      ) : undefined,
      actions: (
        <button
          type="button"
          onClick={acceptInvite}
          disabled={busy || !guest || inviteUnusable}
          className={buttonClass}
        >
          {meta?.requiresApproval ? t('auth.join.sendRequest') : t('auth.join.accept')}
        </button>
      ),
    };
  }

  return (
    <section className="text-text-primary">
      <h1 className="mt-0 text-2xl font-semibold">{t('auth.join.title')}</h1>
      <p className="mt-2 text-text-secondary">{t('auth.join.intro')}</p>

      <div className="mt-4 grid max-w-[640px] gap-4">
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
          extra={
            <div className="relative grid gap-2">
              <CaptchaField gate={guestGate} />
            </div>
          }
          actions={
            <button type="button" onClick={createGuest} disabled={busy} className={secondaryButtonClass}>
              {guest ? t('auth.join.recreateGuest') : t('auth.join.signInAsGuest')}
            </button>
          }
        />
        <Step
          step={3}
          title={meta?.requiresApproval ? t('auth.join.sendRequest') : t('auth.join.accept')}
          description={acceptStep.description}
          extra={acceptStep.extra}
          actions={acceptStep.actions}
        />
      </div>

      <StatusLine status={status} />
    </section>
  );
}

function Step(props: {
  step: number;
  title: string;
  description: string;
  extra?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4">
      <div className="flex items-baseline gap-3">
        <strong className="text-lg">{t('auth.join.stepHeading', { step: props.step, title: props.title })}</strong>
      </div>
      <p className="my-2 text-text-secondary">{props.description}</p>
      {props.extra}
      {props.actions ? <div className="mt-2 flex gap-2">{props.actions}</div> : null}
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const color =
    status.kind === 'busy' ? 'text-text-secondary' : status.kind === 'error' ? 'text-danger' : 'text-success';
  return (
    <p role="status" aria-live="polite" className={`mt-4 ${color}`}>
      {status.kind === 'busy' ? '…' : status.message}
    </p>
  );
}
