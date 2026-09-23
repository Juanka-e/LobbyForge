import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  getInstanceSetupStatus,
  getUserById,
  listAuditLogsForServer,
  listChannelsForServer,
  listInvitesForServer,
  listMembersForServer,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import type { Translator } from '@/lib/i18n/core';
import { getTranslator } from '@/lib/i18n/server';
import InstanceLogoCard from './InstanceLogoCard';
import SettingsShell from '@/app/SettingsShell';
import { rich } from '@/lib/i18n/rich';
import { auditActionLabelKey } from '@/lib/audit-action-labels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.overview.metaTitle') };
}

interface Stats {
  members: number;
  textChannels: number;
  voiceChannels: number;
  invites: number;
  ownerDisplayName: string | null;
  serverName: string;
}

/**
 * Community Settings → Overview.
 *
 * Renders a snapshot of the community the admin is editing. The first
 * server owned by the current user is the candidate — for self-hosted
 * single-tenant instances this is the only server, so the mapping is
 * 1:1. If the admin has no servers yet, we render a friendly empty
 * state pointing at the invites / members pages.
 *
 * Auth gate: admin token cookie is required. Without it the sidebar
 * still renders, but the body shows the standard "Admin token required"
 * note so the admin can see which page they tried to visit.
 */
export default async function CommunitySettingsOverviewPage() {
  const t = await getTranslator();
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.overview.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const setup = await getInstanceSetupStatus(getDb());
  const db = getDb();
  const sessionCookie = cookieStore.toString();
  const session = readGuestSession(sessionCookie, getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let stats: Stats | null = null;
  let recentAudit: { id: string; action: string; actorLabel: string; createdAt: Date }[] = [];

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        const [members, channels, invites, audit] = await Promise.all([
          listMembersForServer(db, firstServer.id),
          listChannelsForServer(db, firstServer.id, { limit: 100 }),
          listInvitesForServer(db, firstServer.id),
          listAuditLogsForServer(db, firstServer.id, { limit: 5 }),
        ]);
        stats = {
          members: members.length,
          textChannels: channels.filter((c) => c.type === 'text').length,
          voiceChannels: channels.filter((c) => c.type === 'voice').length,
          invites: invites.length,
          ownerDisplayName: setup.ownerUserId
            ? (await getUserById(db, setup.ownerUserId))?.displayName ?? null
            : null,
          serverName: firstServer.name,
        };
        recentAudit = audit.map((row) => ({
          id: row.id,
          action: row.action,
          actorLabel: row.actorUserId ?? t('adminSettings.overview.system'),
          createdAt: row.createdAt,
        }));
      }
    } catch {
      // DB may be unavailable in dev — keep stats null so the page still
      // renders the empty state.
    }
  }

  return (
    <SettingsShell scope="community">
      <OverviewBody
        t={t}
        instanceName={setup.instanceName}
        instanceLogoUrl={setup.instanceLogoUrl}
        stats={stats}
        recentAudit={recentAudit}
      />
    </SettingsShell>
  );
}

function OverviewBody({
  t,
  instanceName,
  instanceLogoUrl,
  stats,
  recentAudit,
}: {
  t: Translator;
  instanceName: string;
  instanceLogoUrl: string | null;
  stats: Stats | null;
  recentAudit: { id: string; action: string; actorLabel: string; createdAt: Date }[];
}) {
  return (
    <section className="grid gap-8">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.overview.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {rich(t('adminSettings.overview.subtitle'), { name: <span className="font-medium text-text-primary">{instanceName}</span> })}
        </p>
      </header>

      <section className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle pb-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="size-16 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center">
              <span
                className="material-symbols-outlined text-3xl text-primary"
                style={{ fontVariationSettings: "'FILL' 0" }}
              >
                sports_esports
              </span>
            </div>
            <div>
              <h2 className="text-body-lg font-medium text-text-primary">
                {stats?.serverName ?? instanceName}
              </h2>
              <p className="font-label-sm text-text-muted mt-1">{t('adminSettings.overview.selfHosted')}</p>
            </div>
          </div>
          <a
            href="/admin/settings/members"
            className="rounded-lg border border-border-strong px-4 py-2 font-label-sm text-text-secondary hover:bg-surface-raised transition-colors"
          >
            {t('adminSettings.overview.manageMembers')}
          </a>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <Stat label={t('adminSettings.overview.stat.owner')} value={stats?.ownerDisplayName ?? '—'} />
          <Stat label={t('adminSettings.overview.stat.members')} value={stats ? String(stats.members) : '—'} />
          <Stat
            label={t('adminSettings.overview.stat.channels')}
            value={
              stats
                ? t('adminSettings.overview.stat.channelsValue', {
                    text: stats.textChannels,
                    voice: stats.voiceChannels,
                  })
                : '—'
            }
          />
          <Stat label={t('adminSettings.overview.stat.invites')} value={stats ? String(stats.invites) : '—'} />
        </div>
      </section>

      <InstanceLogoCard initialLogoUrl={instanceLogoUrl} />

      <section>
        <h3 className="font-label-sm text-text-muted uppercase tracking-wider mb-4">
          {t('adminSettings.overview.quickActions')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <QuickAction
            href="/admin/settings/invites"
            icon="person_add"
            title={t('adminSettings.overview.action.inviteTitle')}
            hint={t('adminSettings.overview.action.inviteHint')}
          />
          <QuickAction
            href="/admin/settings/members"
            icon="manage_accounts"
            title={t('adminSettings.overview.manageMembers')}
            hint={t('adminSettings.overview.action.membersHint')}
          />
          <QuickAction
            href="/admin/settings/channels"
            icon="add_circle"
            title={t('adminSettings.overview.action.channelTitle')}
            hint={t('adminSettings.overview.action.channelHint')}
          />
          <QuickAction
            href="/admin/audit"
            icon="history"
            title={t('adminSettings.overview.action.auditTitle')}
            hint={t('adminSettings.overview.action.auditHint')}
          />
        </div>
      </section>

      <section>
        <h3 className="font-label-sm text-text-muted uppercase tracking-wider mb-4">
          {t('adminSettings.overview.recentActivity')}
        </h3>
        <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
          {recentAudit.length === 0 ? (
            <p className="p-4 text-sm text-text-muted">{t('adminSettings.overview.recentEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {recentAudit.map((row) => (
                <li key={row.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="material-symbols-outlined text-text-muted text-[18px]">history</span>
                    <p className="font-label-sm text-text-secondary truncate">
                      <span className="text-text-primary font-medium">{row.actorLabel}</span>{' '}
                      · {actionText(t, row.action)}
                    </p>
                  </div>
                  <span className="text-xs text-text-muted shrink-0">{relativeTime(t, row.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-lg bg-surface-container-low border border-border-subtle p-4 flex gap-3">
        <span className="material-symbols-outlined text-text-muted text-[20px] shrink-0">info</span>
        <p className="text-xs text-text-muted leading-relaxed">{t('adminSettings.overview.footer')}</p>
      </section>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="font-label-sm text-text-primary">{value}</p>
    </div>
  );
}

function QuickAction({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <a
      href={href}
      className="flex flex-col items-start p-4 rounded-xl bg-surface-raised border border-border-subtle hover:bg-surface-container transition-colors text-left"
    >
      <span className="material-symbols-outlined text-primary mb-2">{icon}</span>
      <span className="font-label-sm text-text-primary font-medium">{title}</span>
      <span className="text-xs text-text-muted">{hint}</span>
    </a>
  );
}

/** An audit action as a phrase; unknown actions show their identifier. */
function actionText(t: Translator, action: string): string {
  const key = auditActionLabelKey(action);
  return key ? t(key) : action;
}

function relativeTime(t: Translator, date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('adminSettings.overview.ago.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('adminSettings.overview.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('adminSettings.overview.ago.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('adminSettings.overview.ago.days', { count: days });
  return date.toLocaleDateString(t.locale);
}
