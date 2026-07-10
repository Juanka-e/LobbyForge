'use client';

import { useMemo, useState } from 'react';

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

  const visibleInvites = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return invites.filter((invite) => {
      const status = statusOf(invite);
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [
        invite.code,
        invite.creatorName ?? 'system',
        invite.createdBy ?? '',
        invite.createdAt,
        invite.expiresAt ?? 'never',
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [invites, query, statusFilter]);

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
      setInvites((current) => [{ ...data.invite, creatorName: 'You' }, ...current]);
      setMessage('Invite created.');
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
      setMessage('Invite revoked.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(code: string) {
    try {
      await navigator.clipboard.writeText(joinUrl(code));
      setMessage('Invite link copied.');
    } catch {
      setMessage(joinUrl(code));
    }
  }

  async function copyActiveInvite(invite: InviteView) {
    const status = statusOf(invite);
    if (status !== 'active') {
      setMessage(status === 'expired' ? 'This invite is expired.' : 'This invite has no uses left.');
      return;
    }
    await copyInvite(invite.code);
  }

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Invites</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Create, copy, and revoke links that bring new members into this community.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3">
        <Chip dot="success" label={`${stats.active} active invites`} />
        <Chip dot="danger" label={`${stats.expired} expired`} />
        <Chip icon="analytics" label={`${stats.totalUses} total uses`} />
        {stats.exhausted > 0 ? <Chip dot="muted" label={`${stats.exhausted} exhausted`} /> : null}
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Could not load invites: {loadError}
        </div>
      ) : null}

      <section className="mb-6 rounded-xl border border-border-subtle bg-surface p-5">
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface-container/50 p-3 text-sm text-text-secondary">
          Invite-only communities require a valid link before a new person can join. Revoking a link removes it immediately; already accepted memberships remain intact.
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">Max uses</span>
            <select
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={!canMutate || !serverId || busy}
            >
              <option value="1">1 use</option>
              <option value="5">5 uses</option>
              <option value="25">25 uses</option>
              <option value="100">100 uses</option>
              <option value="unlimited">Unlimited</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">Expires</span>
            <select
              value={expiresIn}
              onChange={(event) => setExpiresIn(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={!canMutate || !serverId || busy}
            >
              <option value="1d">In 1 day</option>
              <option value="7d">In 7 days</option>
              <option value="30d">In 30 days</option>
              <option value="never">Never</option>
            </select>
          </label>
          <button
            type="button"
            onClick={createInvite}
            disabled={!canMutate || !serverId || busy}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Working...' : 'Create invite'}
          </button>
        </div>
        {!canMutate ? (
          <p className="mt-3 text-xs text-text-muted">
            Sign in as an owner or a member with invite permission to create links from this page.
          </p>
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
              placeholder="Search code or creator"
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            className="rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary outline-none"
          >
            <option value="active">Active only</option>
            <option value="all">All invites</option>
            <option value="expired">Expired</option>
            <option value="exhausted">Exhausted</option>
          </select>
        </div>
      </section>

      <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-container/40 text-xs font-semibold uppercase tracking-wider text-text-secondary">
              <th className="px-6 py-3">Invite</th>
              <th className="px-6 py-3">Created by</th>
              <th className="px-6 py-3">Uses</th>
              <th className="px-6 py-3">Expires</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {visibleInvites.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-center text-text-muted">
                  {invites.length === 0 ? 'No invites yet.' : 'No invites match these filters.'}
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
                          Created {new Date(invite.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-primary">
                      {invite.creatorName ?? <span className="text-text-muted">system</span>}
                    </td>
                    <td className="w-32 px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-text-primary">
                          {invite.currentUses}
                          {invite.maxUses !== null ? ` / ${invite.maxUses}` : ' / unlimited'}
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
                    <td className="px-6 py-4 text-text-secondary">{expiresLabelFor(invite.expiresAt)}</td>
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
                          Copy
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingRevoke(invite)}
                          disabled={!canMutate || busy}
                          className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Revoke
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
            <h2 className="text-lg font-semibold text-text-primary">Revoke invite?</h2>
            <p className="mt-2 text-sm text-text-secondary">
              The link <span className="font-mono text-text-primary">{pendingRevoke.code}</span> will stop working immediately.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRevoke(null)}
                disabled={busy}
                className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text-secondary hover:bg-surface-raised disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => revokeInvite(pendingRevoke)}
                disabled={busy}
                className="rounded-lg border border-danger/50 bg-danger/10 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-40"
              >
                {busy ? 'Revoking...' : 'Revoke'}
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

function expiresLabelFor(expiresAt: string | null): string {
  if (!expiresAt) return 'Never';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 7) return `${Math.floor(days / 7)}w`;
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  return '<1h';
}

function StatusPill({ status }: { status: InviteStatus }) {
  const tone =
    status === 'active'
      ? { dot: 'bg-success', text: 'text-text-primary', label: 'Active' }
      : status === 'expired'
        ? { dot: 'bg-danger', text: 'text-text-secondary', label: 'Expired' }
        : { dot: 'bg-text-muted', text: 'text-text-secondary', label: 'Exhausted' };
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
