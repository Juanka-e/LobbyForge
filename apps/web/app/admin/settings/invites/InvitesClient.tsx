'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { rich } from '@/lib/i18n/rich';

export interface InviteView {
  id: string;
  serverId: string;
  createdBy: string | null;
  creatorName: string | null;
  code: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: string | null;
  createdAt: string;
}

type InviteStatus = 'active' | 'exhausted' | 'expired';
type StatusFilter = 'all' | InviteStatus;

function statusOf(invite: InviteView): InviteStatus {
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) return 'expired';
  if (invite.maxUses !== null && invite.currentUses >= invite.maxUses) return 'exhausted';
  return 'active';
}

function joinUrl(code: string): string {
  if (typeof window === 'undefined') return `/join/${code}`;
  return `${window.location.origin}/join/${code}`;
}

export default function InvitesClient({
  serverId,
  initialInvites,
  loadError,
  canMutate,
}: {
  serverId: string | null;
  initialInvites: InviteView[];
  loadError: string | null;
  canMutate: boolean;
}) {
  const t = useT();
  const [invites, setInvites] = useState(initialInvites);
  const [maxUses, setMaxUses] = useState('25');
  const [expiresIn, setExpiresIn] = useState('7d');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<InviteView | null>(null);

  const stats = useMemo(() => {
    let active = 0;
    let expired = 0;
    let exhausted = 0;
    let totalUses = 0;
    for (const inv of invites) {
      totalUses += inv.currentUses;
      const status = statusOf(inv);
      if (status === 'active') active += 1;
      else if (status === 'expired') expired += 1;
      else exhausted += 1;
    }
    return { active, expired, exhausted, totalUses };
  }, [invites]);

  // The words shown for a missing creator / expiry are searchable too,
  // in whichever language the page is in.
  const systemLabel = t('adminSettings.invites.system');
  const neverLabel = t('adminSettings.invites.never');

  const visibleInvites = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return invites.filter((invite) => {
      const status = statusOf(invite);
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [
        invite.code,
        invite.creatorName ?? systemLabel,
        invite.createdBy ?? '',
        invite.createdAt,
        invite.expiresAt ?? neverLabel,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [invites, query, statusFilter, systemLabel, neverLabel]);

  async function createInvite() {
    if (!serverId) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: { maxUses?: number; expiresAt?: string } = {};
      if (maxUses !== 'unlimited') body.maxUses = Number(maxUses);
      const expiresAt = expiresAtFor(expiresIn);
      if (expiresAt) body.expiresAt = expiresAt.toISOString();

      const res = await fetch(`/api/servers/${serverId}/invites`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { invite: Omit<InviteView, 'creatorName'> };
      setInvites((current) => [{ ...data.invite, creatorName: t('adminSettings.invites.you') }, ...current]);
      setMessage(t('adminSettings.invites.created'));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(invite: InviteView) {
    if (!serverId) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/invites/${invite.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      setInvites((current) => current.filter((candidate) => candidate.id !== invite.id));
      setPendingRevoke(null);
      setMessage(t('adminSettings.invites.revoked'));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(code: string) {
    try {
      await navigator.clipboard.writeText(joinUrl(code));
      setMessage(t('adminSettings.invites.copied'));
    } catch {
      setMessage(joinUrl(code));
    }
  }

  async function copyActiveInvite(invite: InviteView) {
    const status = statusOf(invite);
    if (status !== 'active') {
      setMessage(
        status === 'expired' ? t('adminSettings.invites.expiredMessage') : t('adminSettings.invites.exhaustedMessage')
      );
      return;
    }
    await copyInvite(invite.code);
  }

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.invites.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.invites.subtitle')}</p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3">
        <Chip dot="success" label={t('adminSettings.invites.activeCount', { count: stats.active })} />
        <Chip dot="danger" label={t('adminSettings.invites.expiredCount', { count: stats.expired })} />
        <Chip icon="analytics" label={t('adminSettings.invites.totalUses', { count: stats.totalUses })} />
        {stats.exhausted > 0 ? (
          <Chip dot="muted" label={t('adminSettings.invites.exhaustedCount', { count: stats.exhausted })} />
        ) : null}
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('adminSettings.invites.loadError', { error: loadError })}
        </div>
      ) : null}

      <section className="mb-6 rounded-xl border border-border-subtle bg-surface p-5">
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface-container/50 p-3 text-sm text-text-secondary">
          {t('adminSettings.invites.explainer')}
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">{t('adminSettings.invites.maxUses')}</span>
            <select
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={!canMutate || !serverId || busy}
            >
              <option value="1">{t('adminSettings.invites.uses', { count: 1 })}</option>
              <option value="5">{t('adminSettings.invites.uses', { count: 5 })}</option>
              <option value="25">{t('adminSettings.invites.uses', { count: 25 })}</option>
              <option value="100">{t('adminSettings.invites.uses', { count: 100 })}</option>
              <option value="unlimited">{t('adminSettings.invites.unlimited')}</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">{t('adminSettings.invites.expiresLabel')}</span>
            <select
              value={expiresIn}
              onChange={(event) => setExpiresIn(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={!canMutate || !serverId || busy}
            >
              <option value="1d">{t('adminSettings.invites.expiresIn', { count: 1 })}</option>
              <option value="7d">{t('adminSettings.invites.expiresIn', { count: 7 })}</option>
              <option value="30d">{t('adminSettings.invites.expiresIn', { count: 30 })}</option>
              <option value="never">{neverLabel}</option>
            </select>
          </label>
          <button
            type="button"
            onClick={createInvite}
            disabled={!canMutate || !serverId || busy}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t('adminSettings.invites.working') : t('adminSettings.invites.create')}
          </button>
        </div>
        {!canMutate ? (
          <p className="mt-3 text-xs text-text-muted">{t('adminSettings.invites.cannotMutate')}</p>
        ) : null}
        {message ? <p className="mt-3 text-xs text-text-secondary">{message}</p> : null}
      </section>

      <section className="mb-4 rounded-xl border border-border-subtle bg-surface p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
          <label className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-surface-container px-3 py-2">
            <span className="material-symbols-outlined text-lg text-text-muted">search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('adminSettings.invites.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            className="rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary outline-none"
          >
            <option value="active">{t('adminSettings.invites.filter.active')}</option>
            <option value="all">{t('adminSettings.invites.filter.all')}</option>
            <option value="expired">{t('adminSettings.invites.status.expired')}</option>
            <option value="exhausted">{t('adminSettings.invites.status.exhausted')}</option>
          </select>
        </div>
      </section>

      <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-container/40 text-xs font-semibold uppercase tracking-wider text-text-secondary">
              <th className="px-6 py-3">{t('adminSettings.invites.col.invite')}</th>
              <th className="px-6 py-3">{t('adminSettings.invites.col.createdBy')}</th>
              <th className="px-6 py-3">{t('adminSettings.invites.col.uses')}</th>
              <th className="px-6 py-3">{t('adminSettings.invites.col.expires')}</th>
              <th className="px-6 py-3">{t('adminSettings.invites.col.status')}</th>
              <th className="px-6 py-3 text-right">{t('adminSettings.invites.col.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {visibleInvites.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-center text-text-muted">
                  {invites.length === 0 ? t('adminSettings.invites.empty') : t('adminSettings.invites.emptyFiltered')}
                </td>
              </tr>
            ) : (
              visibleInvites.map((invite) => {
                const status = statusOf(invite);
                const usesPct =
                  invite.maxUses && invite.maxUses > 0
                    ? Math.min(100, Math.round((invite.currentUses / invite.maxUses) * 100))
                    : null;
                return (
                  <tr
                    key={invite.id}
                    className={`transition-colors hover:bg-surface-raised/50 ${status !== 'active' ? 'opacity-60' : ''}`}
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-mono font-medium text-text-primary">{invite.code}</span>
                        <span className="text-xs text-text-muted">
                          {t('adminSettings.invites.createdOn', {
                            date: new Date(invite.createdAt).toLocaleDateString(t.locale),
                          })}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-primary">
                      {invite.creatorName ?? <span className="text-text-muted">{systemLabel}</span>}
                    </td>
                    <td className="w-32 px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-text-primary">
                          {invite.maxUses !== null
                            ? `${invite.currentUses} / ${invite.maxUses}`
                            : t('adminSettings.invites.usesUnlimited', { count: invite.currentUses })}
                        </span>
                        {usesPct !== null ? (
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
                            <div
                              className={`h-full rounded-full ${status === 'exhausted' ? 'bg-danger' : 'bg-primary'}`}
                              style={{ width: `${usesPct}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-secondary">{expiresLabelFor(t, invite.expiresAt)}</td>
                    <td className="px-6 py-4">
                      <StatusPill status={status} />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => copyActiveInvite(invite)}
                          className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
                        >
                          {t('adminSettings.invites.copy')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingRevoke(invite)}
                          disabled={!canMutate || busy}
                          className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('adminSettings.invites.revoke')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pendingRevoke ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-semibold text-text-primary">{t('adminSettings.invites.revokeTitle')}</h2>
            <p className="mt-2 text-sm text-text-secondary">
              {rich(t('adminSettings.invites.revokeBody'), { code: <span className="font-mono text-text-primary">{pendingRevoke.code}</span> })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRevoke(null)}
                disabled={busy}
                className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text-secondary hover:bg-surface-raised disabled:opacity-40"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => revokeInvite(pendingRevoke)}
                disabled={busy}
                className="rounded-lg border border-danger/50 bg-danger/10 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-40"
              >
                {busy ? t('adminSettings.invites.revoking') : t('adminSettings.invites.revoke')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function expiresAtFor(value: string): Date | null {
  if (value === 'never') return null;
  const days = value === '1d' ? 1 : value === '30d' ? 30 : 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function expiresLabelFor(t: Translator, expiresAt: string | null): string {
  if (!expiresAt) return t('adminSettings.invites.never');
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return t('adminSettings.invites.status.expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 7) return t('adminSettings.invites.left.weeks', { count: Math.floor(days / 7) });
  if (days >= 1) return t('adminSettings.invites.left.days', { count: days });
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return t('adminSettings.invites.left.hours', { count: hours });
  return t('adminSettings.invites.left.underHour');
}

function StatusPill({ status }: { status: InviteStatus }) {
  const t = useT();
  const tone =
    status === 'active'
      ? { dot: 'bg-success', text: 'text-text-primary', label: t('adminSettings.invites.status.active') }
      : status === 'expired'
        ? { dot: 'bg-danger', text: 'text-text-secondary', label: t('adminSettings.invites.status.expired') }
        : { dot: 'bg-text-muted', text: 'text-text-secondary', label: t('adminSettings.invites.status.exhausted') };
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
      <span className={`text-xs font-medium ${tone.text}`}>{tone.label}</span>
    </div>
  );
}

function Chip({
  label,
  dot,
  icon,
}: {
  label: string;
  dot?: 'success' | 'danger' | 'muted';
  icon?: string;
}) {
  return (
    <span className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-floating px-4 py-2 text-sm text-text-primary">
      {dot ? (
        <span
          className={`h-2 w-2 rounded-full ${dot === 'success' ? 'bg-success' : dot === 'danger' ? 'bg-danger' : 'bg-text-muted'}`}
        />
      ) : null}
      {icon ? <span className="material-symbols-outlined text-[16px] text-primary">{icon}</span> : null}
      {label}
    </span>
  );
}
