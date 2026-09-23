/**
 * Server home — the page a member lands on after picking a server.
 *
 * What it shows (M15.3 — server-home MVP):
 *   - Server header (name, owner, signed-in state)
 *   - Channel list, with a "Join voice" deep link for voice channels
 *   - Member list with kick controls (owner only)
 *   - Active invites with a "create invite" form (owner / CREATE_INVITE)
 *   - Role list (read-only — reordering is M15.6)
 *   - Audit log (read-only, scoped to the new M15.2 endpoint, owner only)
 *
 * All data loads client-side via the existing M11-M14 APIs — there's no
 * server component doing DB reads here. That keeps the page resilient to
 * the auth flow: if the cookie isn't present yet, we surface a 401
 * inline and let the user re-issue POST /api/auth/guest from /connect.
 *
 * Voice deep-link uses /room/{channelId}?serverId={id}&channelId={id};
 * the room page then connects to LiveKit and posts the 5s presence
 * heartbeat. This page itself doesn't open the mic — it only renders
 * the affordance.
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreateChannelModal, type CreateChannelInput } from '@/components/modals/CreateChannelModal';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import SettingsModalFrame from '../../SettingsModalFrame';
import { rich } from '@/lib/i18n/rich';
import { pluginSummary } from '@/lib/plugin-catalog-text';

type Channel = {
  id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
  position: number;
  topic: string | null;
};

type Member = {
  userId: string;
  displayName: string;
  isOwner: boolean;
  roleId: string | null;
};

type Role = {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: string[];
};

type Invite = {
  id: string;
  code: string;
  createdBy: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: string | null;
  createdAt: string;
};

type AuditLog = {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ServerApp = {
  id: string;
  name: string;
  version: string;
  type: string;
  catalog: {
    summary?: string;
    publisher?: string;
    trustLevel?: string;
    playerConfig?: {
      minPlayers?: number;
      maxPlayers?: number;
      defaultMaxPlayers?: number;
      supportsSpectators?: boolean;
      supportsQueue?: boolean;
      overflowPolicy?: string;
    };
    tags?: string[];
  } | null;
  installed: boolean;
  enabled: boolean;
  settings: {
    allowedChannelIds?: string[];
    allowedRoleIds?: string[];
    defaultMaxPlayers?: number;
    overflowPolicy?: 'spectator' | 'queue' | 'split' | 'reject';
  };
  installedAt: string | null;
};

type AppOverflowPolicy = NonNullable<ServerApp['settings']['overflowPolicy']>;

type AccessPolicy = {
  joinPolicy: 'invite_only' | 'public_with_approval' | 'public_self_register' | 'guest_allowed';
  externalIdentity: 'off' | 'allow_lobbyforge' | 'require_lobbyforge_for_registry';
  localAccount: 'allow_local_email_password' | 'existing_local_users_only' | 'guest_only_invites';
  accountLinking: 'allow_link' | 'auto_create_from_lobbyforge' | 'require_admin_approval_first_join';
  requireApprovalForFirstJoin: boolean;
  updatedAt: string | null;
};

type Bot = {
  id: string;
  serverId: string;
  name: string;
  type: string;
  permissions: string[];
  enabled: boolean;
  createdAt: string;
  tokenConfigured: boolean;
  trustLevel: 'official' | 'verified' | 'unverified' | string;
};

type Server = {
  id: string;
  name: string;
  ownerUserId: string;
};

type Tab = 'overview' | 'apps' | 'access' | 'bots' | 'roles' | 'invites' | 'audit';

const TAB_META: Record<Tab, { labelKey: string; icon: string }> = {
  overview: { labelKey: 'hub.servers.tab.overview', icon: 'dashboard' },
  apps: { labelKey: 'hub.servers.tab.apps', icon: 'apps' },
  access: { labelKey: 'hub.servers.tab.access', icon: 'shield_lock' },
  bots: { labelKey: 'hub.servers.tab.bots', icon: 'smart_toy' },
  roles: { labelKey: 'hub.servers.tab.roles', icon: 'admin_panel_settings' },
  invites: { labelKey: 'hub.servers.tab.invites', icon: 'link' },
  audit: { labelKey: 'hub.servers.tab.audit', icon: 'history' },
};

/** Permission codes with a human label (`hub.servers.permission.<code>`). */
const KNOWN_PERMISSIONS = new Set([
  'administrator',
  'manage_server',
  'manage_channels',
  'manage_roles',
  'kick_members',
  'ban_members',
  'create_invite',
  'send_messages',
  'manage_messages',
  'add_reactions',
  'connect_voice',
  'speak',
  'mute_members',
  'deafen_members',
  'view_audit_log',
  'start_activity',
]);

function permissionLabel(t: Translator, code: string): string {
  return KNOWN_PERMISSIONS.has(code) ? t(`hub.servers.permission.${code}`) : code;
}

/** Plugin and bot trust levels are codes; show the word players see. */
function trustLabel(t: Translator, level: string): string {
  if (level === 'official') return t('hub.trust.official');
  if (level === 'verified' || level === 'verified-community') return t('hub.trust.verified');
  if (level === 'unverified') return t('hub.trust.unverified');
  return level;
}

const VALID_TABS: Tab[] = ['overview', 'apps', 'access', 'bots', 'roles', 'invites', 'audit'];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status} ${JSON.stringify(detail)}`);
  }
  return (await res.json()) as T;
}

export default function ServerPage({ params }: { params: Promise<{ id: string }> }) {
  const [serverId, setServerId] = useState<string | null>(null);
  const search = useSearchParams();
  const initialTab = (search?.get('tab') as Tab | null) ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await params;
      if (!cancelled) setServerId(resolved.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  if (!serverId) return <ServerSettingsLoading />;

  return (
    <Suspense fallback={<ServerSettingsLoading />}>
      <ServerHome
        serverId={serverId}
        initialTab={initialTab && VALID_TABS.includes(initialTab) ? initialTab : 'overview'}
      />
    </Suspense>
  );
}

function ServerSettingsLoading() {
  const t = useT();
  return (
    <SettingsModalFrame label={t('hub.servers.loading')}>
      <div className="grid h-dvh place-items-center bg-background p-6">
        <div className="text-center text-text-muted">
          <span className="material-symbols-outlined animate-spin text-3xl" aria-hidden>progress_activity</span>
          <p className="mt-2 text-sm">{t('hub.servers.loading')}</p>
        </div>
      </div>
    </SettingsModalFrame>
  );
}

function ServerHome({ serverId, initialTab }: { serverId: string; initialTab: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<Server | null>(null);
  const [me, setMe] = useState<{ uid: string | null }>({ uid: null });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [apps, setApps] = useState<ServerApp[]>([]);
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await jsonFetch<{ guest: { uid: string | null } }>('/api/auth/guest', {
          method: 'GET',
        });
        if (!cancelled) setMe({ uid: data.guest.uid });
      } catch {
        if (!cancelled) setMe({ uid: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [serverData, channelsData, membersData, rolesData, invitesData, appsData, accessData, botsData] = await Promise.all([
        jsonFetch<{ server: Server }>(`/api/servers/${serverId}`),
        jsonFetch<{ channels: Channel[] }>(`/api/servers/${serverId}/channels`),
        jsonFetch<{ members: Member[] }>(`/api/servers/${serverId}/members`),
        jsonFetch<{ roles: Role[] }>(`/api/servers/${serverId}/roles`),
        jsonFetch<{ invites: Invite[] }>(`/api/servers/${serverId}/invites`),
        jsonFetch<{ apps: ServerApp[] }>(`/api/servers/${serverId}/apps`),
        jsonFetch<{ accessPolicy: AccessPolicy }>(`/api/servers/${serverId}/access-policy`),
        jsonFetch<{ bots: Bot[] }>(`/api/servers/${serverId}/bots`),
      ]);
      setServer(serverData.server);
      setChannels(channelsData.channels);
      setMembers(membersData.members);
      setRoles(rolesData.roles);
      setInvites(invitesData.invites);
      setApps(appsData.apps);
      setAccessPolicy(accessData.accessPolicy);
      setBots(botsData.bots);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (tab === 'audit') {
      try {
        const data = await jsonFetch<{ auditLogs: AuditLog[] }>(
          `/api/servers/${serverId}/audit-logs`
        );
        setAuditLogs(data.auditLogs);
      } catch (err) {
        setError((err as Error).message);
      }
    }
  }, [serverId, tab]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOwner = me.uid !== null && server?.ownerUserId === me.uid;

  const sortedChannels = useMemo(
    () => [...channels].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [channels]
  );
  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => a.position - b.position),
    [roles]
  );

  if (error && !server) {
    return (
      <SettingsModalFrame label={t('hub.servers.errorLabel')}>
        <div className="grid h-dvh place-items-center bg-background p-6">
          <div className="max-w-md text-center">
            <span className="material-symbols-outlined text-3xl text-danger" aria-hidden>error</span>
            <h1 className="mt-3 text-lg font-semibold text-text-primary">{t('hub.servers.unavailable')}</h1>
            <p className="mt-2 text-sm text-text-secondary">{error}</p>
          </div>
        </div>
      </SettingsModalFrame>
    );
  }

  return (
    <SettingsModalFrame label={t('hub.servers.frameLabel', { name: server?.name ?? t('hub.servers.fallbackName') })}>
    <section className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      <aside className="flex-none border-b border-border-subtle bg-surface md:w-64 md:border-b-0 md:border-r">
        <header className="h-16 border-b border-border-subtle px-5 pr-16 flex items-center gap-3 md:pr-5">
          <div className="min-w-0">
            <p className="truncate text-xs text-text-muted">{t('hub.servers.eyebrow')}</p>
            <h1 className="truncate text-balance text-sm font-semibold text-text-primary">{server?.name ?? t('hub.servers.fallbackName')}</h1>
          </div>
        </header>

      <nav className="flex gap-1 overflow-x-auto p-2 md:block md:space-y-1 md:p-3" aria-label={t('hub.servers.navLabel')}>
        {VALID_TABS.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            disabled={id === 'audit' && !isOwner}
            className={tab === id
              ? 'flex min-w-max w-full items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-left text-sm font-medium text-primary'
              : 'flex min-w-max w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40'}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>{TAB_META[id].icon}</span>
            {t(TAB_META[id].labelKey)}
          </button>
        ))}
      </nav>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-8 md:px-10 md:py-10 lg:px-14">
        <div className="mx-auto w-full max-w-5xl">
          <header className="mb-7">
            <h2 className="text-balance text-2xl font-semibold text-text-primary">{t(TAB_META[tab].labelKey)}</h2>
            {server ? (
              <p className="mt-1 truncate text-xs text-text-muted">
                {server.id}
                {isOwner ? ` · ${t('hub.servers.ownerAccess')}` : ''}
              </p>
            ) : null}
          </header>

      {tab === 'overview' ? (
        <Overview
          channels={sortedChannels}
          members={members}
          serverId={serverId}
          meUid={me.uid}
          isOwner={isOwner}
          onChanged={reload}
        />
      ) : tab === 'apps' ? (
        <AppsPanel apps={apps} serverId={serverId} isOwner={isOwner} onChanged={reload} />
      ) : tab === 'access' ? (
        <AccessPanel
          policy={accessPolicy}
          serverId={serverId}
          isOwner={isOwner}
          onChanged={reload}
        />
      ) : tab === 'bots' ? (
        <BotsPanel bots={bots} isOwner={isOwner} />
      ) : tab === 'roles' ? (
        <RolesPanel roles={sortedRoles} members={members} />
      ) : tab === 'invites' ? (
        <InvitesPanel
          invites={invites}
          serverId={serverId}
          meUid={me.uid}
          isOwner={isOwner}
          onChanged={reload}
        />
      ) : (
        <AuditPanel logs={auditLogs} />
      )}
        </div>
      </main>
    </section>
    </SettingsModalFrame>
  );
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="grid min-h-28 place-items-center rounded-lg border border-dashed border-border-strong bg-surface/40 p-5 text-center">
      <div>
        <span className="material-symbols-outlined text-2xl text-text-muted" aria-hidden>{icon}</span>
        <p className="mt-1 text-sm text-text-muted">{message}</p>
      </div>
    </div>
  );
}

function StatusBadge({ children, tone }: { children: ReactNode; tone: 'primary' | 'success' | 'warning' | 'muted' }) {
  const toneClass = {
    primary: 'border-primary/30 bg-primary/10 text-primary',
    success: 'border-success/30 bg-success/10 text-success',
    warning: 'border-tertiary/30 bg-tertiary/10 text-tertiary',
    muted: 'border-border-strong bg-surface-container text-text-muted',
  }[tone];
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${toneClass}`}>{children}</span>;
}

function SettingsField({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">{description}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Overview({
  channels,
  members,
  serverId,
  meUid,
  isOwner,
  onChanged,
}: {
  channels: Channel[];
  members: Member[];
  serverId: string;
  meUid: string | null;
  isOwner: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreateChannel(input: CreateChannelInput) {
    setCreating(true);
    setCreateError(null);
    try {
      await jsonFetch(`/api/servers/${serverId}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          type: input.type,
          topic: input.visibility === 'private' ? t('hub.servers.channels.privateTopic') : null,
        }),
      });
      setCreateOpen(false);
      await onChanged();
    } catch (err) {
      setCreateError((err as Error).message);
      throw err;
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-8 xl:grid-cols-2">
      <section className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('hub.servers.channels.title')}</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('hub.servers.channels.count', { count: channels.length })}
            </p>
          </div>
          {isOwner || meUid ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
            >
              <span className="material-symbols-outlined text-base" aria-hidden>add</span>
              {t('hub.servers.channels.add')}
            </button>
          ) : null}
        </div>
        <CreateChannelModal
          open={createOpen}
          onClose={() => {
            if (!creating) {
              setCreateOpen(false);
              setCreateError(null);
            }
          }}
          onSave={handleCreateChannel}
        />
        {createError ? (
          <p className="mb-2 text-xs text-danger" role="alert">
            {createError}
          </p>
        ) : null}
        <ul className="space-y-2">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
            >
              <span className="material-symbols-outlined text-lg text-text-muted" aria-hidden>
                {c.type === 'voice' ? 'volume_up' : c.type === 'stage' ? 'campaign' : 'tag'}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{c.name}</span>
              <span className="hidden text-xs text-text-muted sm:inline">
                {t(`hub.servers.channelType.${c.type}`)}
              </span>
              {c.type === 'voice' ? (
                <a
                  href={`/room/${c.id}?serverId=${serverId}&channelId=${c.id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-success/10"
                >
                  <span className="material-symbols-outlined text-base" aria-hidden>login</span>
                  {t('hub.servers.channels.joinVoice')}
                </a>
              ) : null}
            </li>
          ))}
          {channels.length === 0 ? (
            <li><EmptyState icon="forum" message={t('hub.servers.channels.empty')} /></li>
          ) : null}
        </ul>
      </section>

      <section className="min-w-0">
        <div className="mb-3 border-b border-border-subtle pb-3">
          <h3 className="text-sm font-semibold text-text-primary">{t('hub.servers.members.title')}</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('hub.servers.members.count', { count: members.length })}
          </p>
        </div>
        <ul className="space-y-2">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
            >
              <span className="grid size-8 flex-none place-items-center rounded-full bg-surface-container text-xs font-semibold text-text-secondary" aria-hidden>
                {m.displayName.trim().charAt(0).toUpperCase() || '?'}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{m.displayName}</span>
              {m.isOwner ? <StatusBadge tone="primary">{t('hub.servers.members.owner')}</StatusBadge> : null}
              {meUid && !m.isOwner ? (
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(t('hub.servers.members.kickConfirm', { name: m.displayName }))) return;
                    try {
                      await jsonFetch(`/api/servers/${serverId}/members/${m.userId}`, {
                        method: 'DELETE',
                      });
                      await onChanged();
                    } catch (err) {
                      alert(t('hub.servers.members.kickFailed', { error: (err as Error).message }));
                    }
                  }}
                  disabled={!isOwner}
                  className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:text-text-muted"
                >
                  {isOwner ? t('hub.servers.members.kick') : t('hub.servers.ownerOnly')}
                </button>
              ) : null}
            </li>
          ))}
          {members.length === 0 ? (
            <li><EmptyState icon="group" message={t('hub.servers.members.empty')} /></li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}

function AppsPanel({
  apps,
  serverId,
  isOwner,
  onChanged,
}: {
  apps: ServerApp[];
  serverId: string;
  isOwner: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const save = useCallback(
    async (pluginId: string, patch: Partial<Pick<ServerApp, 'enabled' | 'settings'>>) => {
      setBusyPluginId(pluginId);
      try {
        await jsonFetch(`/api/servers/${serverId}/apps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId, ...patch }),
        });
        await onChanged();
      } catch (err) {
        alert(t('hub.servers.apps.updateFailed', { error: (err as Error).message }));
      } finally {
        setBusyPluginId(null);
      }
    },
    [serverId, onChanged, t]
  );

  const uninstall = useCallback(
    async (pluginId: string) => {
      if (!confirm(t('hub.servers.apps.uninstallConfirm'))) return;
      setBusyPluginId(pluginId);
      try {
        await jsonFetch(`/api/servers/${serverId}/apps`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId }),
        });
        await onChanged();
      } catch (err) {
        alert(t('hub.servers.apps.uninstallFailed', { error: (err as Error).message }));
      } finally {
        setBusyPluginId(null);
      }
    },
    [serverId, onChanged, t]
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('hub.servers.apps.intro')}</p>
      <div className="grid gap-3">
        {apps.map((app) => {
          const playerConfig = app.catalog?.playerConfig;
          const summary = pluginSummary(app.id, t.locale, app.catalog?.summary ?? null);
          const settings = app.settings ?? {};
          const maxPlayers = settings.defaultMaxPlayers ?? playerConfig?.defaultMaxPlayers ?? '';
          const manifestOverflow =
            playerConfig?.overflowPolicy === 'spectator' ||
            playerConfig?.overflowPolicy === 'queue' ||
            playerConfig?.overflowPolicy === 'split' ||
            playerConfig?.overflowPolicy === 'reject'
              ? playerConfig.overflowPolicy
              : 'spectator';
          const overflowPolicy: AppOverflowPolicy = settings.overflowPolicy ?? manifestOverflow;
          const disabled = !isOwner || busyPluginId === app.id;
          return (
            <section
              key={app.id}
              className="rounded-lg border border-border-subtle bg-surface p-4"
            >
              <header className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-text-primary">{app.name}</strong>
                <span className="text-xs text-text-muted">v{app.version}</span>
                {app.catalog?.trustLevel ? (
                  <StatusBadge tone="success">{trustLabel(t, app.catalog.trustLevel)}</StatusBadge>
                ) : null}
                <StatusBadge tone={app.installed && app.enabled ? 'success' : 'muted'}>
                  {app.installed
                    ? app.enabled
                      ? t('hub.servers.apps.enabled')
                      : t('hub.servers.apps.disabled')
                    : t('hub.servers.apps.notInstalled')}
                </StatusBadge>
              </header>
              {summary ? <p className="mt-2 text-sm text-text-secondary">{summary}</p> : null}
              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
                {app.installed ? (
                  <>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => save(app.id, { enabled: !app.enabled, settings })}
                      className="rounded-md border border-border-strong px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-container disabled:opacity-40"
                    >
                      {app.enabled ? t('hub.servers.apps.disable') : t('hub.servers.apps.enable')}
                    </button>
                    <label className="grid gap-1 text-xs text-text-muted">
                      <span>{t('hub.servers.apps.maxPlayers')}</span>
                      <input
                        type="number"
                        min={playerConfig?.minPlayers ?? 1}
                        max={playerConfig?.maxPlayers ?? 500}
                        value={maxPlayers}
                        disabled={disabled}
                        onChange={(e) => {
                          const value = Number(e.target.value);
                          if (!Number.isInteger(value) || value <= 0) return;
                          void save(app.id, { settings: { ...settings, defaultMaxPlayers: value } });
                        }}
                        className="w-24 rounded-md border border-border-strong bg-surface-dim px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-text-muted">
                      <span>{t('hub.servers.apps.overflow')}</span>
                      <select
                        value={overflowPolicy}
                        disabled={disabled}
                        onChange={(e) => save(app.id, { settings: { ...settings, overflowPolicy: e.target.value as ServerApp['settings']['overflowPolicy'] } })}
                        className="rounded-md border border-border-strong bg-surface-dim px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
                      >
                        <option value="spectator">{t('hub.servers.apps.overflow.spectator')}</option>
                        <option value="queue">{t('hub.servers.apps.overflow.queue')}</option>
                        <option value="split">{t('hub.servers.apps.overflow.split')}</option>
                        <option value="reject">{t('hub.servers.apps.overflow.reject')}</option>
                      </select>
                    </label>
                    <button type="button" disabled={disabled} onClick={() => uninstall(app.id)} className="ml-auto rounded-md px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-40">
                      {t('hub.servers.apps.uninstall')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      save(app.id, {
                        enabled: true,
                        settings: {
                          defaultMaxPlayers: playerConfig?.defaultMaxPlayers,
                          overflowPolicy: manifestOverflow,
                        },
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary-container px-3 py-2 text-xs font-semibold text-on-primary-container disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined text-base" aria-hidden>add</span>
                    {isOwner ? t('hub.servers.apps.install') : t('hub.servers.ownerOnly')}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {apps.length === 0 ? <EmptyState icon="extension" message={t('hub.servers.apps.empty')} /> : null}
    </div>
  );
}

function AccessPanel({
  policy,
  serverId,
  isOwner,
  onChanged,
}: {
  policy: AccessPolicy | null;
  serverId: string;
  isOwner: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<AccessPolicy | null>(policy);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await jsonFetch(`/api/servers/${serverId}/access-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          joinPolicy: draft.joinPolicy,
          externalIdentity: draft.externalIdentity,
          localAccount: draft.localAccount,
          accountLinking: draft.accountLinking,
          requireApprovalForFirstJoin: draft.requireApprovalForFirstJoin,
        }),
      });
      await onChanged();
    } catch (err) {
      alert(t('hub.servers.access.saveFailed', { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }, [draft, serverId, onChanged, t]);

  if (!draft) {
    return <EmptyState icon="progress_activity" message={t('hub.servers.access.loading')} />;
  }

  const disabled = !isOwner || busy;

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-text-secondary">{t('hub.servers.access.intro')}</p>
      <div className="divide-y divide-border-subtle border-y border-border-subtle">
        <SettingsField label={t('hub.servers.access.join.label')} description={t('hub.servers.access.join.description')}>
          <select
            value={draft.joinPolicy}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, joinPolicy: e.target.value as AccessPolicy['joinPolicy'] })}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary sm:w-64"
          >
            <option value="invite_only">{t('hub.servers.access.join.inviteOnly')}</option>
            <option value="public_with_approval">{t('hub.servers.access.join.publicWithApproval')}</option>
            <option value="public_self_register">{t('hub.servers.access.join.publicSelfRegister')}</option>
            <option value="guest_allowed">{t('hub.servers.access.join.guestAllowed')}</option>
          </select>
        </SettingsField>
        <SettingsField label={t('hub.servers.access.external.label')} description={t('hub.servers.access.external.description')}>
          <select
            value={draft.externalIdentity}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, externalIdentity: e.target.value as AccessPolicy['externalIdentity'] })}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary sm:w-64"
          >
            <option value="off">{t('hub.servers.access.external.off')}</option>
            <option value="allow_lobbyforge">{t('hub.servers.access.external.allow')}</option>
            <option value="require_lobbyforge_for_registry">{t('hub.servers.access.external.requireForRegistry')}</option>
          </select>
        </SettingsField>
        <SettingsField label={t('hub.servers.access.local.label')} description={t('hub.servers.access.local.description')}>
          <select
            value={draft.localAccount}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, localAccount: e.target.value as AccessPolicy['localAccount'] })}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary sm:w-64"
          >
            <option value="allow_local_email_password">{t('hub.servers.access.local.allowEmailPassword')}</option>
            <option value="existing_local_users_only">{t('hub.servers.access.local.existingOnly')}</option>
            <option value="guest_only_invites">{t('hub.servers.access.local.guestOnlyInvites')}</option>
          </select>
        </SettingsField>
        <SettingsField label={t('hub.servers.access.linking.label')} description={t('hub.servers.access.linking.description')}>
          <select
            value={draft.accountLinking}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, accountLinking: e.target.value as AccessPolicy['accountLinking'] })}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary sm:w-64"
          >
            <option value="allow_link">{t('hub.servers.access.linking.allowLink')}</option>
            <option value="auto_create_from_lobbyforge">{t('hub.servers.access.linking.autoCreate')}</option>
            <option value="require_admin_approval_first_join">{t('hub.servers.access.linking.requireApproval')}</option>
          </select>
        </SettingsField>
        <SettingsField label={t('hub.servers.access.approval.label')} description={t('hub.servers.access.approval.description')}>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={draft.requireApprovalForFirstJoin}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, requireApprovalForFirstJoin: e.target.checked })}
              className="size-4 rounded border-border-strong bg-surface text-primary focus:ring-primary"
            />
            {t('hub.servers.access.approval.required')}
          </label>
        </SettingsField>
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={save} disabled={disabled} className="rounded-md bg-primary-container px-4 py-2.5 text-sm font-semibold text-on-primary-container disabled:cursor-not-allowed disabled:opacity-40">
          {isOwner
            ? busy
              ? t('hub.servers.access.saving')
              : t('hub.servers.access.save')
            : t('hub.servers.ownerOnly')}
        </button>
      </div>
    </div>
  );
}

function BotsPanel({ bots, isOwner }: { bots: Bot[]; isOwner: boolean }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('hub.servers.bots.intro')}</p>
      {bots.length === 0 ? (
        <EmptyState icon="smart_toy" message={t('hub.servers.bots.empty')} />
      ) : (
        <div className="grid gap-3">
          {bots.map((bot) => (
            <section key={bot.id} className="rounded-lg border border-border-subtle bg-surface p-4">
              <header className="flex flex-wrap items-center gap-2">
                <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><span className="material-symbols-outlined text-xl" aria-hidden>smart_toy</span></span>
                <strong className="text-sm text-text-primary">{bot.name}</strong>
                <StatusBadge tone="primary">{t('hub.servers.bots.badge')}</StatusBadge>
                <StatusBadge tone={bot.trustLevel === 'official' ? 'success' : 'warning'}>
                  {trustLabel(t, bot.trustLevel)}
                </StatusBadge>
                <StatusBadge tone={bot.enabled ? 'success' : 'muted'}>
                  {bot.enabled ? t('hub.servers.bots.ready') : t('hub.servers.apps.disabled')}
                </StatusBadge>
              </header>
              <p className="mt-3 text-xs text-text-muted">
                {rich(t(bot.tokenConfigured ? 'hub.servers.bots.typeTokenSet' : 'hub.servers.bots.typeTokenMissing'), { type: <code>{bot.type}</code> })}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {bot.permissions.length === 0 ? (
                  <span className="text-xs text-text-muted">{t('hub.servers.bots.noPermissions')}</span>
                ) : (
                  bot.permissions.map((permission) => (
                    <span key={permission} className="rounded bg-surface-container px-2 py-1 text-[11px] text-text-secondary">
                      {permissionLabel(t, permission)}
                    </span>
                  ))
                )}
              </div>
              {isOwner ? (
                <button type="button" disabled className="mt-4 rounded-md border border-border-strong px-3 py-2 text-xs text-text-muted opacity-50">
                  {t('hub.servers.bots.configure')}
                </button>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function RolesPanel({ roles, members }: { roles: Role[]; members: Member[] }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('hub.servers.roles.intro')}</p>
      {roles.length === 0 ? <EmptyState icon="shield" message={t('hub.servers.roles.empty')} /> : (
      <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="bg-surface-container-low text-left text-xs text-text-muted">
            <th className="px-4 py-3 font-medium">{t('hub.servers.roles.name')}</th>
            <th className="px-4 py-3 font-medium">{t('hub.servers.members.title')}</th>
            <th className="px-4 py-3 font-medium">{t('hub.servers.roles.permissions')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const count = members.filter((m) => m.roleId === r.id).length;
            return (
              <tr key={r.id} className="border-t border-border-subtle">
                <td className="px-4 py-3 font-medium text-text-primary">
                  <span className="mr-2 inline-block size-2 rounded-full" style={{ backgroundColor: r.color ?? '#9aa3ad' }} aria-hidden />
                  {r.name}
                </td>
                <td className="px-4 py-3 text-text-secondary">{count}</td>
                <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5">
                  {r.permissions.map((p) => (
                    <span key={p} className="rounded bg-surface-container px-2 py-1 text-[11px] text-text-secondary">
                      {permissionLabel(t, p)}
                    </span>
                  ))}
                </div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}

function InvitesPanel({
  invites,
  serverId,
  meUid,
  isOwner,
  onChanged,
}: {
  invites: Invite[];
  serverId: string;
  meUid: string | null;
  isOwner: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const create = useCallback(
    async (maxUses: number | null) => {
      setBusy(true);
      try {
        await jsonFetch(`/api/servers/${serverId}/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(maxUses === null ? {} : { maxUses }),
        });
        await onChanged();
      } catch (err) {
        alert(t('hub.servers.invites.createFailed', { error: (err as Error).message }));
      } finally {
        setBusy(false);
      }
    },
    [serverId, onChanged, t]
  );

  const revoke = useCallback(
    async (inviteId: string) => {
      if (!confirm(t('hub.servers.invites.revokeConfirm'))) return;
      try {
        await jsonFetch(`/api/servers/${serverId}/invites/${inviteId}`, {
          method: 'DELETE',
        });
        await onChanged();
      } catch (err) {
        alert(t('hub.servers.invites.revokeFailed', { error: (err as Error).message }));
      }
    },
    [serverId, onChanged, t]
  );

  if (!meUid) {
    return <EmptyState icon="login" message={t('hub.servers.invites.signIn')} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{t('hub.servers.invites.intro')}</p>

      {isOwner || invites.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => create(null)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-primary-container px-3 py-2 text-xs font-semibold text-on-primary-container disabled:opacity-40">
            <span className="material-symbols-outlined text-base" aria-hidden>link</span>
            {t('hub.servers.invites.createUnlimited')}
          </button>
          <button type="button" onClick={() => create(5)} disabled={busy} className="rounded-md border border-border-strong px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-container disabled:opacity-40">
            {t('hub.servers.invites.createLimited', { count: 5 })}
          </button>
        </div>
      ) : null}

      <ul className="space-y-2">
        {invites.map((inv) => (
          <li key={inv.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{inv.code}</code>
            <span className="text-xs text-text-muted">
              {t('hub.servers.invites.uses', { used: inv.currentUses, max: inv.maxUses ?? '∞' })}
              {inv.expiresAt
                ? ` · ${t('hub.servers.invites.expires', {
                    date: new Date(inv.expiresAt).toLocaleString(t.locale),
                  })}`
                : ''}
            </span>
            {isOwner ? (
              <button type="button" onClick={() => revoke(inv.id)} className="self-start rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10 sm:self-auto">
                {t('hub.servers.invites.revoke')}
              </button>
            ) : null}
          </li>
        ))}
        {invites.length === 0 ? (
          <li><EmptyState icon="link_off" message={t('hub.servers.invites.empty')} /></li>
        ) : null}
      </ul>
    </div>
  );
}

function AuditPanel({ logs }: { logs: AuditLog[] }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t('hub.servers.audit.intro')}</p>
      {logs.length === 0 ? (
        <EmptyState icon="history" message={t('hub.servers.audit.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-surface-container-low text-left text-xs text-text-muted">
              <th className="px-4 py-3 font-medium">{t('hub.servers.audit.when')}</th>
              <th className="px-4 py-3 font-medium">{t('hub.servers.audit.action')}</th>
              <th className="px-4 py-3 font-medium">{t('hub.servers.audit.actor')}</th>
              <th className="px-4 py-3 font-medium">{t('hub.servers.audit.target')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((row) => (
              <tr key={row.id} className="border-t border-border-subtle">
                <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                  {new Date(row.createdAt).toLocaleString(t.locale)}
                </td>
                <td className="px-4 py-3 font-medium text-text-primary">{row.action}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-muted">
                  {row.actorUserId ? row.actorUserId.slice(0, 8) : t('hub.servers.audit.system')}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-text-muted">
                  {row.targetType ? `${row.targetType}:` : ''}
                  {row.targetId ? row.targetId.slice(0, 8) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
