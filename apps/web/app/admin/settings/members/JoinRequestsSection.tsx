'use client';

/**
 * The join approval queue on the Members settings page: people the
 * server's access policy holds for a moderator (invite redeem or the lobby
 * auto-join filed a request). Approve creates the membership; reject
 * keeps them out and stops new requests for a cooldown. Every decision is
 * authorized again by the API (KICK_MEMBERS or MANAGE_SERVER).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/client';
import type { JoinRequestJson } from '@/lib/join-requests';

const PAGE_SIZE = 25;
/** An account younger than this gets a "New account" badge. */
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

type LoadState = 'loading' | 'ready' | 'forbidden' | 'failed';
type Notice = { tone: 'success' | 'danger'; text: string };

export default function JoinRequestsSection({ serverId }: { serverId: string }) {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<LoadState>('loading');
  const [requests, setRequests] = useState<JoinRequestJson[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const base = `/api/servers/${encodeURIComponent(serverId)}/join-requests`;

  const load = useCallback(
    async (offset: number) => {
      const response = await fetch(`${base}?status=pending&limit=${PAGE_SIZE}&offset=${offset}`, {
        credentials: 'same-origin',
      });
      if (response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('failed');
        return;
      }
      const data = (await response.json()) as {
        requests: JoinRequestJson[];
        pendingCount: number;
        nextOffset: number | null;
      };
      setRequests((current) => (offset === 0 ? data.requests : [...current, ...data.requests]));
      setPendingCount(data.pendingCount);
      setHasMore(data.nextOffset !== null);
      setState('ready');
    },
    [base]
  );

  useEffect(() => {
    load(0).catch(() => setState('failed'));
  }, [load]);

  const askedFormat = useMemo(
    () => new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [t.locale]
  );

  function removeRequest(id: string) {
    setRequests((current) => current.filter((item) => item.id !== id));
    setPendingCount((count) => Math.max(0, count - 1));
  }

  async function decide(request: JoinRequestJson, action: 'approve' | 'reject') {
    if (busyId) return;
    if (action === 'reject' && !window.confirm(t('adminSettings.joinRequests.confirmReject', { name: request.displayName }))) {
      return;
    }
    setBusyId(request.id);
    setNotice(null);
    try {
      const response = await fetch(`${base}/${encodeURIComponent(request.id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      if (response.status === 409 && data.code === 'banned') {
        removeRequest(request.id);
        setNotice({ tone: 'danger', text: t('adminSettings.joinRequests.bannedRejected', { name: request.displayName }) });
        return;
      }
      if (response.status === 409 || response.status === 404) {
        removeRequest(request.id);
        setNotice({ tone: 'danger', text: t('adminSettings.joinRequests.alreadyDecided') });
        return;
      }
      if (!response.ok) {
        throw new Error(data.error ?? String(response.status));
      }
      removeRequest(request.id);
      if (action === 'approve') {
        setNotice({ tone: 'success', text: t('adminSettings.joinRequests.approved', { name: request.displayName }) });
        // The new member belongs in the list below.
        router.refresh();
      } else {
        setNotice({ tone: 'success', text: t('adminSettings.joinRequests.rejected', { name: request.displayName }) });
      }
    } catch (err) {
      setNotice({ tone: 'danger', text: t('adminSettings.joinRequests.actionFailed', { error: (err as Error).message }) });
    } finally {
      setBusyId(null);
    }
  }

  function viaText(request: JoinRequestJson): string {
    if (request.source === 'auto_join') return t('adminSettings.joinRequests.viaLobby');
    if (request.inviterName) return t('adminSettings.joinRequests.viaInviteFrom', { name: request.inviterName });
    if (request.inviteCode) return t('adminSettings.joinRequests.viaInviteCode', { code: request.inviteCode });
    return t('adminSettings.joinRequests.viaInvite');
  }

  return (
    <section aria-labelledby="join-requests-title" className="mb-8 rounded-xl border border-border-subtle bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-6 py-4">
        <div>
          <h2 id="join-requests-title" className="text-lg font-semibold text-text-primary">
            {t('adminSettings.joinRequests.title')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.joinRequests.subtitle')}</p>
        </div>
        {state === 'ready' ? (
          <span
            className={
              pendingCount > 0
                ? 'rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary'
                : 'rounded-full border border-border-subtle bg-surface-raised px-3 py-1 text-xs font-medium text-text-secondary'
            }
          >
            {t('adminSettings.joinRequests.pendingCount', { count: pendingCount })}
          </span>
        ) : null}
      </header>

      <div role="status" aria-live="polite" className="empty:hidden">
        {notice ? (
          <p
            className={
              notice.tone === 'success'
                ? 'mx-6 mt-4 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-success'
                : 'mx-6 mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger'
            }
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      {state === 'loading' ? (
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.joinRequests.loading')}</p>
      ) : state === 'forbidden' ? (
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.joinRequests.forbidden')}</p>
      ) : state === 'failed' ? (
        <p className="px-6 py-5 text-sm text-danger">{t('adminSettings.joinRequests.loadFailed')}</p>
      ) : requests.length === 0 ? (
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.joinRequests.empty')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {requests.map((request) => {
            const busy = busyId === request.id;
            const isNewAccount = Date.now() - new Date(request.accountCreatedAt).getTime() < NEW_ACCOUNT_MS;
            return (
              <li key={request.id} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start">
                <div
                  aria-hidden
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-variant font-label-sm text-text-secondary"
                >
                  {request.displayName.trim().charAt(0).toUpperCase() || '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-text-primary">{request.displayName}</span>
                    {request.isGuest ? <Badge label={t('common.guest')} /> : null}
                    {isNewAccount ? <Badge label={t('adminSettings.joinRequests.newAccount')} tone="warning" /> : null}
                  </div>
                  <p className="mt-0.5 text-[13px] text-text-muted">
                    {t('adminSettings.joinRequests.askedAt', { date: askedFormat.format(new Date(request.createdAt)) })}
                    {' · '}
                    {viaText(request)}
                  </p>
                  {request.note ? (
                    <figure className="mt-2">
                      <figcaption className="sr-only">{t('adminSettings.joinRequests.noteLabel')}</figcaption>
                      <blockquote className="whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-container-low px-3 py-2 text-sm text-text-secondary">
                        {request.note}
                      </blockquote>
                    </figure>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2 sm:pt-1">
                  <button
                    type="button"
                    onClick={() => decide(request, 'approve')}
                    disabled={busy || busyId !== null}
                    aria-label={t('adminSettings.joinRequests.approveAria', { name: request.displayName })}
                    className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
                  >
                    {t('adminSettings.joinRequests.approve')}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(request, 'reject')}
                    disabled={busy || busyId !== null}
                    aria-label={t('adminSettings.joinRequests.rejectAria', { name: request.displayName })}
                    className="rounded-lg border border-danger/40 px-3 py-2 text-xs font-semibold text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:opacity-50"
                  >
                    {t('adminSettings.joinRequests.reject')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {state === 'ready' && hasMore ? (
        <div className="border-t border-border-subtle px-6 py-3">
          <button
            type="button"
            onClick={() => load(requests.length).catch(() => setState('failed'))}
            className="text-sm font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            {t('adminSettings.joinRequests.loadMore')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Badge({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'warning' }) {
  // `ember` is the themed amber (darker ink on the light theme).
  const className =
    tone === 'warning'
      ? 'rounded border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ember'
      : 'rounded border border-border-subtle bg-surface-variant px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted';
  return <span className={className}>{label}</span>;
}
