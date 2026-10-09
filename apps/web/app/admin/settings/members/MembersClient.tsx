'use client';

import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import JoinRequestsSection from './JoinRequestsSection';

export interface MemberView {
  userId: string;
  displayName: string;
  globalDisplayName: string;
  nickname: string | null;
  avatarUrl: string | null;
  isGuest: boolean;
  roleName: string | null;
  roleColor: string | null;
  roleIds: string[];
  joinedAt: string;
  /**
   * EMAIL.md §5: whether the account proved its address. `none` for guests
   * and accounts without one; absent when it could not be read.
   */
  emailState?: 'verified' | 'unverified' | 'none';
}

export interface RoleOption {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: string[];
}

/**
 * What the viewer may do, worked out on the server from the same rules the
 * routes apply: a control the viewer could only be refused is not drawn.
 */
export interface MemberCapabilities {
  /** Manage Roles — the role picker and Save roles. */
  setRoles: boolean;
  /** Kick Members — Kick (leaving yourself is always allowed). */
  kick: boolean;
  /** Ban Members. */
  ban: boolean;
  /** Kick Members or Manage Community — the join-request queue. */
  reviewJoinRequests: boolean;
  /** Instance admin — marking an address verified. */
  verifyEmail: boolean;
}

const ALL_CAPABILITIES: MemberCapabilities = {
  setRoles: true,
  kick: true,
  ban: true,
  reviewJoinRequests: true,
  verifyEmail: true,
};

type SortMode = 'recent' | 'oldest' | 'name';

export default function MembersClient({
  serverId,
  currentUserId,
  ownerUserId,
  members,
  roles,
  loadError,
  capabilities = ALL_CAPABILITIES,
}: {
  serverId: string | null;
  currentUserId: string | null;
  ownerUserId: string | null;
  members: MemberView[];
  roles: RoleOption[];
  loadError: string | null;
  capabilities?: MemberCapabilities;
}) {
  const t = useT();
  const [memberList, setMemberList] = useState(members);
  // An approved join request refreshes the page: take the new server list.
  useEffect(() => setMemberList(members), [members]);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [draftRoles, setDraftRoles] = useState<string[]>([]);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // A member with no role shows as "Guest" or "Member" — interface words,
  // so they follow the language; real role names are data and do not.
  const guestLabel = t('common.guest');
  const memberLabel = t('adminSettings.members.memberRole');
  const roleNameOf = (member: MemberView) => member.roleName ?? (member.isGuest ? guestLabel : memberLabel);

  const roleOptions = useMemo(() => {
    const names = new Set<string>();
    for (const member of memberList) names.add(member.roleName ?? (member.isGuest ? guestLabel : memberLabel));
    return ['all', ...Array.from(names).sort((a, b) => a.localeCompare(b))];
  }, [memberList, guestLabel, memberLabel]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return memberList
      .filter((member) => {
        const roleName = member.roleName ?? (member.isGuest ? guestLabel : memberLabel);
        if (roleFilter !== 'all' && roleName !== roleFilter) return false;
        if (!normalizedQuery) return true;
        return [
          member.displayName,
          member.globalDisplayName,
          member.nickname ?? '',
          member.userId,
          roleName,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => {
        if (sortMode === 'name') return a.displayName.localeCompare(b.displayName);
        const aTime = new Date(a.joinedAt).getTime();
        const bTime = new Date(b.joinedAt).getTime();
        return sortMode === 'recent' ? bTime - aTime : aTime - bTime;
      });
  }, [memberList, query, roleFilter, sortMode, guestLabel, memberLabel]);

  const joinedFormat = useMemo(
    () => new Intl.DateTimeFormat(t.locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    [t.locale]
  );

  const total = memberList.length;
  const guests = memberList.filter((m) => m.isGuest).length;
  const moderators = memberList.filter((m) => /mod|admin|owner/i.test(m.roleName ?? '')).length;

  function openMember(member: MemberView) {
    if (expandedUserId === member.userId) {
      setExpandedUserId(null);
      return;
    }
    setExpandedUserId(member.userId);
    setDraftRoles(member.roleIds);
    setMessage(null);
  }

  async function saveRoles(member: MemberView) {
    if (!serverId || busyUserId) return;
    setBusyUserId(member.userId);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(member.userId)}/role`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleIds: draftRoles }),
        }
      );
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t('adminSettings.members.rolesFailed'));
      const roleById = new Map(roles.map((role) => [role.id, role]));
      const primary = draftRoles.map((id) => roleById.get(id)).filter(Boolean)[0] ?? null;
      setMemberList((current) =>
        current.map((item) =>
          item.userId === member.userId
            ? { ...item, roleIds: draftRoles, roleName: primary?.name ?? null, roleColor: primary?.color ?? null }
            : item
        )
      );
      setMessage({ tone: 'success', text: t('adminSettings.members.rolesUpdated') });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyUserId(null);
    }
  }

  async function kickMember(member: MemberView) {
    if (!serverId || busyUserId) return;
    if (!window.confirm(t('adminSettings.members.confirmKick', { name: member.displayName }))) return;
    setBusyUserId(member.userId);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(member.userId)}`,
        { method: 'DELETE' }
      );
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t('adminSettings.members.kickFailed'));
      setMemberList((current) => current.filter((item) => item.userId !== member.userId));
      setExpandedUserId(null);
      setMessage({ tone: 'success', text: t('adminSettings.members.kicked') });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyUserId(null);
    }
  }

  async function banMember(member: MemberView) {
    if (!serverId || busyUserId) return;
    const reason = window.prompt(t('adminSettings.members.banPrompt', { name: member.displayName }));
    if (reason === null) return;
    setBusyUserId(member.userId);
    setMessage(null);
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/bans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: member.userId, reason: reason.trim() || undefined }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t('adminSettings.members.banFailed'));
      setMemberList((current) => current.filter((item) => item.userId !== member.userId));
      setExpandedUserId(null);
      setMessage({ tone: 'success', text: t('adminSettings.members.banned') });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyUserId(null);
    }
  }

  async function markEmailVerified(member: MemberView) {
    if (busyUserId) return;
    setBusyUserId(member.userId);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(member.userId)}/verify-email`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 404 ? t('adminSettings.members.email.markNotFound') : t('adminSettings.members.email.markFailed')
        );
      }
      setMemberList((current) =>
        current.map((item) => (item.userId === member.userId ? { ...item, emailState: 'verified' } : item))
      );
      setMessage({ tone: 'success', text: t('adminSettings.members.email.marked', { name: member.displayName }) });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyUserId(null);
    }
  }

  function toggleDraftRole(roleId: string) {
    setDraftRoles((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId]
    );
  }

  return (
    <section className="max-w-4xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.members.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.members.subtitle')}</p>
      </header>

      {serverId && capabilities.reviewJoinRequests ? <JoinRequestsSection serverId={serverId} /> : null}

      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">
            search
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('adminSettings.members.searchPlaceholder')}
            className="w-full bg-surface border border-border-subtle rounded-lg py-2 pl-10 pr-4 text-text-primary placeholder-text-muted focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container transition-all"
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="sr-only" htmlFor="member-role-filter">{t('adminSettings.members.roleFilter')}</label>
          <select
            id="member-role-filter"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary-container"
          >
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {role === 'all' ? t('adminSettings.members.allRoles') : role}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="member-sort">{t('adminSettings.members.sortLabel')}</label>
          <select
            id="member-sort"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary-container"
          >
            <option value="recent">{t('adminSettings.members.sort.recent')}</option>
            <option value="oldest">{t('adminSettings.members.sort.oldest')}</option>
            <option value="name">{t('adminSettings.members.sort.name')}</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip label={t('adminSettings.members.count', { count: total })} />
        <Chip label={t('adminSettings.members.moderatorCount', { count: moderators })} tone="primary" />
        <Chip label={t('adminSettings.members.guestCount', { count: guests })} tone="muted" />
        {filtered.length !== total ? (
          <Chip label={t('adminSettings.members.shownCount', { count: filtered.length })} tone="primary" />
        ) : null}
      </div>

      {loadError ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('adminSettings.members.loadError', { error: loadError })}
        </div>
      ) : null}
      {!serverId ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('adminSettings.common.noServer')}
        </div>
      ) : null}
      {message ? (
        <div
          className={
            message.tone === 'success'
              ? 'mb-4 rounded-lg border border-success/40 bg-success/10 p-4 text-sm text-success'
              : 'mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger'
          }
        >
          {message.text}
        </div>
      ) : null}

      <div className="bg-surface rounded-xl border border-border-subtle overflow-hidden">
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-6 py-3 border-b border-border-subtle bg-surface-dim/50">
          <div className="col-span-2 font-label-sm uppercase tracking-wider text-text-muted">
            {t('adminSettings.members.col.member')}
          </div>
          <div className="font-label-sm uppercase tracking-wider text-text-muted hidden sm:block">
            {t('adminSettings.members.col.joined')}
          </div>
          <div className="font-label-sm uppercase tracking-wider text-text-muted text-right">
            {t('adminSettings.members.col.role')}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">
            {memberList.length === 0
              ? t('adminSettings.members.emptyNone')
              : t('adminSettings.members.emptyFiltered')}
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {filtered.map((member) => {
              const expanded = expandedUserId === member.userId;
              const protectedMember = member.userId === ownerUserId;
              const self = member.userId === currentUserId;
              const busy = busyUserId === member.userId;
              // Only the actions this viewer may take on this member; with
              // none, the row offers no drawer at all.
              const showMarkVerified = capabilities.verifyEmail && member.emailState === 'unverified';
              const showKick = !protectedMember && (capabilities.kick || self);
              const showBan = capabilities.ban && !protectedMember && !self;
              const hasActions = capabilities.setRoles || showMarkVerified || showKick || showBan;
              return (
                <li key={member.userId} className="hover:bg-surface-raised/50 transition-colors">
                  <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-6 py-4 items-center">
                    <Avatar name={member.displayName} url={member.avatarUrl} />
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="font-label-sm text-text-primary truncate font-medium">
                          {member.displayName}
                        </span>
                        {member.nickname ? (
                          <RoleBadge label={t('adminSettings.members.badge.nickname')} tone="primary" />
                        ) : null}
                        {member.isGuest ? <RoleBadge label={guestLabel} tone="muted" /> : null}
                        {member.emailState === 'verified' || member.emailState === 'unverified' ? (
                          <EmailStateBadge state={member.emailState} />
                        ) : null}
                        {protectedMember ? (
                          <RoleBadge label={t('adminSettings.members.badge.owner')} tone="danger" />
                        ) : null}
                      </div>
                      <div className="text-text-muted text-[13px] truncate">
                        {member.nickname ? `${member.globalDisplayName} - ` : ''}ID {member.userId.slice(0, 8)}
                      </div>
                    </div>
                    <div className="text-text-secondary text-[13px] hidden sm:block whitespace-nowrap">
                      {joinedFormat.format(new Date(member.joinedAt))}
                    </div>
                    <div className="text-right">
                      <RoleBadge
                        label={roleNameOf(member)}
                        tone={member.roleName ? 'primary' : 'muted'}
                        color={member.roleColor}
                      />
                    </div>
                    {hasActions ? (
                      <button
                        type="button"
                        onClick={() => openMember(member)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-secondary hover:bg-surface-container hover:text-text-primary"
                        aria-label={t('adminSettings.members.manage', { name: member.displayName })}
                      >
                        <span className="material-symbols-outlined text-[18px]">{expanded ? 'expand_less' : 'more_horiz'}</span>
                      </button>
                    ) : (
                      <span className="h-8 w-8" aria-hidden />
                    )}
                  </div>
                  {expanded && hasActions ? (
                    <div className="border-t border-border-subtle bg-surface-container-low px-6 py-4">
                      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
                        {capabilities.setRoles ? (
                        <div>
                          <p className="mb-3 text-xs uppercase tracking-wider text-text-muted">
                            {t('adminSettings.members.roles')}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {roles.map((role) => {
                              const checked = draftRoles.includes(role.id);
                              return (
                                <button
                                  key={role.id}
                                  type="button"
                                  onClick={() => toggleDraftRole(role.id)}
                                  disabled={busy}
                                  className={
                                    checked
                                      ? 'rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50'
                                      : 'rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary disabled:opacity-50'
                                  }
                                >
                                  {role.name}
                                </button>
                              );
                            })}
                          </div>
                          {roles.some((role) => draftRoles.includes(role.id) && role.permissions.includes('administrator')) ? (
                            <p className="mt-3 text-xs text-danger">{t('adminSettings.members.adminWarning')}</p>
                          ) : null}
                        </div>
                        ) : (
                          <div />
                        )}
                        <div className="flex flex-wrap items-end gap-2 lg:justify-end">
                          {showMarkVerified ? (
                            <button
                              type="button"
                              onClick={() => markEmailVerified(member)}
                              disabled={busy}
                              className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-surface-container hover:text-text-primary disabled:opacity-50"
                            >
                              {t('adminSettings.members.email.mark')}
                            </button>
                          ) : null}
                          {capabilities.setRoles ? (
                            <button
                              type="button"
                              onClick={() => saveRoles(member)}
                              disabled={busy}
                              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
                            >
                              {t('adminSettings.members.saveRoles')}
                            </button>
                          ) : null}
                          {showKick ? (
                            <button
                              type="button"
                              onClick={() => kickMember(member)}
                              disabled={busy}
                              className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-semibold text-text-secondary disabled:opacity-50"
                            >
                              {self ? t('adminSettings.members.leave') : t('adminSettings.members.kick')}
                            </button>
                          ) : null}
                          {showBan ? (
                            <button
                              type="button"
                              onClick={() => banMember(member)}
                              disabled={busy}
                              className="rounded-lg border border-danger/40 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                            >
                              {t('adminSettings.members.ban')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-6 text-xs text-text-muted">{t('adminSettings.members.footer')}</p>
    </section>
  );
}

/** Words and an icon, never colour alone (verified / not verified). */
function EmailStateBadge({ state }: { state: 'verified' | 'unverified' }) {
  const t = useT();
  const verified = state === 'verified';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-text-primary ${
        verified ? 'border-success/40 bg-success/10' : 'border-ember/40 bg-ember/10'
      }`}
    >
      <span className={`material-symbols-outlined text-[13px] ${verified ? 'text-success' : 'text-ember'}`} aria-hidden>
        {verified ? 'verified' : 'mark_email_unread'}
      </span>
      {t(verified ? 'adminSettings.members.email.verified' : 'adminSettings.members.email.unverified')}
    </span>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const t = useT();
  const initial = initialOf(name, { locale: t.locale });
  return (
    <div className="relative w-10 h-10 rounded-full bg-surface-variant border border-border-strong overflow-hidden flex items-center justify-center text-text-secondary font-label-sm">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
        <img src={url} alt={name} className="w-full h-full object-cover" />
      ) : (
        <span aria-hidden>{initial}</span>
      )}
    </div>
  );
}

function Chip({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'primary' }) {
  const className =
    tone === 'primary'
      ? 'px-3 py-1 bg-primary/10 border border-primary/20 rounded-full text-primary text-xs font-medium'
      : 'px-3 py-1 bg-surface-raised border border-border-subtle rounded-full text-text-secondary text-xs font-medium';
  return <span className={className}>{label}</span>;
}

function RoleBadge({
  label,
  tone,
  color,
}: {
  label: string;
  tone: 'primary' | 'muted' | 'danger';
  color?: string | null;
}) {
  const className =
    tone === 'danger'
      ? 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-danger/20 text-danger border border-danger/30 uppercase tracking-wide'
      : tone === 'primary'
        ? 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20 uppercase tracking-wide'
        : 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-variant text-text-muted border border-border-subtle uppercase tracking-wide';
  return (
    <span className={className} style={color ? { color, borderColor: color } : undefined}>
      {label}
    </span>
  );
}
