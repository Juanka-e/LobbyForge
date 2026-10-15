'use client';

/**
 * Banned people on the Members settings page, with "Lift ban". There was
 * no screen for it: a ban made from the profile card or the member list
 * could only be undone through the API. Reads `GET /api/servers/{id}/bans`
 * (owner, Ban Members, Moderate Members or View Audit Log) and lifts with
 * `DELETE /api/servers/{id}/bans?userId=…` (Ban Members; a timed-out
 * moderator is refused) — both authorize again.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { profileActionErrorMessage, GENERIC_REFUSAL_KEY } from '@/lib/profile-action-errors';

interface BanJson {
  id: string;
  userId: string;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  displayName: string | null;
}

type LoadState = 'loading' | 'ready' | 'forbidden' | 'failed';
type Notice = { tone: 'success' | 'danger'; text: string };

export default function BansSection({ serverId }: { serverId: string }) {
  const t = useT();
  const [state, setState] = useState<LoadState>('loading');
  const [bans, setBans] = useState<BanJson[]>([]);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [confirmUserId, setConfirmUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const base = `/api/servers/${encodeURIComponent(serverId)}/bans`;

  const load = useCallback(async () => {
    const response = await fetch(base, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 403) return setState('forbidden');
    if (!response.ok) return setState('failed');
    const data = (await response.json()) as { bans?: BanJson[] };
    const now = Date.now();
    // An expired ban no longer keeps anyone out: not listed.
    setBans((data.bans ?? []).filter((ban) => !ban.expiresAt || Date.parse(ban.expiresAt) > now));
    setState('ready');
  }, [base]);

  useEffect(() => {
    load().catch(() => setState('failed'));
  }, [load]);

  const dateFormat = useMemo(() => new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }), [t.locale]);

  async function lift(ban: BanJson) {
    if (busyUserId) return;
    const name = ban.displayName ?? t('adminSettings.bans.unknownUser');
    setBusyUserId(ban.userId);
    setNotice(null);
    try {
      const response = await fetch(`${base}?userId=${encodeURIComponent(ban.userId)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { code?: string };
        const message = profileActionErrorMessage('ban', { status: response.status, code: data.code });
        setNotice({
          tone: 'danger',
          text: message.key === GENERIC_REFUSAL_KEY ? t('adminSettings.bans.liftFailed', { status: response.status }) : t(message.key, message.params),
        });
        return;
      }
      setBans((current) => current.filter((item) => item.userId !== ban.userId));
      setNotice({ tone: 'success', text: t('adminSettings.bans.lifted', { name }) });
    } catch {
      setNotice({ tone: 'danger', text: t('adminSettings.bans.network') });
    } finally {
      setBusyUserId(null);
      setConfirmUserId(null);
    }
  }

  return (
    <section aria-labelledby="bans-title" className="mb-8 rounded-xl border border-border-subtle bg-surface" data-testid="bans-section">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-6 py-4">
        <div>
          <h2 id="bans-title" className="text-lg font-semibold text-text-primary">
            {t('adminSettings.bans.title')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.bans.subtitle')}</p>
        </div>
        {state === 'ready' ? (
          <span className="rounded-full border border-border-subtle bg-surface-raised px-3 py-1 text-xs font-medium text-text-secondary">
            {t('adminSettings.bans.count', { count: bans.length })}
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
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.bans.loading')}</p>
      ) : state === 'forbidden' ? (
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.bans.forbidden')}</p>
      ) : state === 'failed' ? (
        <p className="px-6 py-5 text-sm text-danger">{t('adminSettings.bans.loadFailed')}</p>
      ) : bans.length === 0 ? (
        <p className="px-6 py-5 text-sm text-text-muted">{t('adminSettings.bans.empty')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {bans.map((ban) => {
            const name = ban.displayName ?? t('adminSettings.bans.unknownUser');
            const busy = busyUserId === ban.userId;
            return (
              <li key={ban.id} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start" data-ban-user={ban.userId}>
                <div
                  aria-hidden
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-variant font-label-sm text-text-secondary"
                >
                  {initialOf(name, { locale: t.locale })}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">{name}</p>
                  <p className="mt-0.5 text-[13px] text-text-muted">
                    {t('adminSettings.bans.since', { date: dateFormat.format(new Date(ban.createdAt)) })}
                    {' · '}
                    {ban.expiresAt
                      ? t('adminSettings.bans.until', { date: dateFormat.format(new Date(ban.expiresAt)) })
                      : t('adminSettings.bans.permanent')}
                  </p>
                  {ban.reason ? (
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-container-low px-3 py-2 text-sm text-text-secondary">
                      <span className="sr-only">{t('adminSettings.bans.reasonLabel')}: </span>
                      {ban.reason}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
                  {confirmUserId === ban.userId ? (
                    <>
                      <span className="text-xs text-text-secondary">{t('adminSettings.bans.confirm', { name })}</span>
                      <button
                        type="button"
                        onClick={() => void lift(ban)}
                        disabled={busy}
                        autoFocus
                        className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
                      >
                        {t('adminSettings.bans.lift')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmUserId(null)}
                        disabled={busy}
                        className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmUserId(ban.userId)}
                      disabled={busyUserId !== null}
                      aria-label={t('adminSettings.bans.liftAria', { name })}
                      className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-semibold text-text-primary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                    >
                      {t('adminSettings.bans.lift')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
