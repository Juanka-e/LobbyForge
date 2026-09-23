'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { auditActionLabelKey } from '@/lib/audit-action-labels';

export interface AuditEntryView {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
  createdAt: string;
}

type Category =
  | 'all'
  | 'moderation'
  | 'roles'
  | 'invites'
  | 'channels'
  | 'messages'
  | 'activities'
  | 'system'
  | 'other';

const CATEGORY_LABEL_KEYS: Record<Category, string> = {
  all: 'admin.audit.category.all',
  moderation: 'admin.audit.category.moderation',
  roles: 'admin.audit.category.roles',
  invites: 'admin.audit.category.invites',
  channels: 'admin.audit.category.channels',
  messages: 'admin.audit.category.messages',
  activities: 'admin.audit.category.activities',
  system: 'admin.audit.category.system',
  other: 'admin.audit.category.other',
};

function actionLabel(t: Translator, action: string): string {
  const key = auditActionLabelKey(action);
  return key ? t(key) : describeAction(action).actionLabel;
}

const FILTERS: Category[] = [
  'all',
  'moderation',
  'roles',
  'invites',
  'channels',
  'messages',
  'activities',
  'system',
  'other',
];

export default function AuditClient({
  entries,
  loadError,
}: {
  entries: AuditEntryView[];
  loadError: string | null;
}) {
  const t = useT();
  const systemActor = t('admin.audit.systemActor');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  const decorated = useMemo(
    () =>
      entries.map((entry) => ({
        ...entry,
        category: categorizeAction(entry.action),
        metadataText: stableJson(entry.metadata),
        timestamp: new Date(entry.createdAt).getTime(),
      })),
    [entries]
  );

  const counts = useMemo(() => {
    const next = new Map<Category, number>();
    for (const filter of FILTERS) next.set(filter, 0);
    next.set('all', decorated.length);
    for (const entry of decorated) {
      next.set(entry.category, (next.get(entry.category) ?? 0) + 1);
    }
    return next;
  }, [decorated]);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return decorated
      .filter((entry) => {
        if (category !== 'all' && entry.category !== category) return false;
        if (!normalizedQuery) return true;
        const haystack = [
          entry.action,
          actionLabel(t, entry.action),
          entry.actorName ?? systemActor,
          entry.targetType ?? '',
          entry.targetId ?? '',
          entry.metadataText,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => (sort === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
  }, [category, decorated, query, sort, systemActor, t]);

  function exportCsv() {
    const rows = visibleEntries.map((entry) => [
      entry.createdAt,
      entry.actorName ?? systemActor,
      entry.action,
      t(CATEGORY_LABEL_KEYS[entry.category]),
      entry.targetType ?? '',
      entry.targetId ?? '',
      entry.metadataText,
    ]);
    const csv = [
      ['created_at', 'actor', 'action', 'category', 'target_type', 'target_id', 'metadata'],
      ...rows,
    ]
      .map((row) => row.map(formatCsvCell).join(','))
      .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{t('admin.audit.title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('admin.audit.intro')}</p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={visibleEntries.length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-raised px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            download
          </span>
          {t('admin.audit.exportCsv')}
        </button>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label={t('admin.audit.summary.loaded')} value={entries.length} />
        <SummaryCard
          label={t('admin.audit.summary.moderation')}
          value={counts.get('moderation') ?? 0}
          tone="danger"
        />
        <SummaryCard
          label={t('admin.audit.summary.roles')}
          value={counts.get('roles') ?? 0}
          tone="tertiary"
        />
        <SummaryCard
          label={t('admin.audit.summary.invites')}
          value={counts.get('invites') ?? 0}
          tone="muted"
        />
      </div>

      <div className="mb-5 rounded-xl border border-border-subtle bg-surface p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
          <label className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-surface-container px-3 py-2">
            <span className="material-symbols-outlined text-lg text-text-muted" aria-hidden>
              search
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('admin.audit.searchLabel')}
              placeholder={t('admin.audit.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value === 'oldest' ? 'oldest' : 'newest')}
            aria-label={t('admin.audit.sortLabel')}
            className="rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary outline-none"
          >
            <option value="newest">{t('admin.audit.sortNewest')}</option>
            <option value="oldest">{t('admin.audit.sortOldest')}</option>
          </select>
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((filter) => {
            const active = filter === category;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setCategory(filter)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? 'border-primary-container bg-primary-container/15 text-primary'
                    : 'border-border-subtle bg-surface-container text-text-secondary hover:text-text-primary'
                }`}
              >
                {t(CATEGORY_LABEL_KEYS[filter])} ({counts.get(filter) ?? 0})
              </button>
            );
          })}
        </div>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('admin.audit.loadError', { error: loadError })}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {visibleEntries.length === 0 ? (
          <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center text-sm text-text-muted">
            {entries.length === 0 ? t('admin.audit.empty') : t('admin.audit.noMatch')}
          </div>
        ) : (
          visibleEntries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
        )}
      </div>
    </section>
  );
}

function AuditRow({
  entry,
}: {
  entry: AuditEntryView & { category: Category; metadataText: string; timestamp: number };
}) {
  const t = useT();
  const { icon, tone } = describeAction(entry.action);
  const targetKind = entry.targetType ? targetTypeLabel(t, entry.targetType) : null;
  const target = targetKind
    ? `${targetKind}${entry.targetId ? `: ${truncate(entry.targetId, 24)}` : ''}`
    : null;

  return (
    <article className="rounded-xl border border-border-subtle bg-surface p-4 transition-colors hover:bg-surface-raised/40">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${tone.classes.bg} ${tone.classes.border}`}
        >
          <span className={`material-symbols-outlined text-lg ${tone.classes.icon}`}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-text-primary">
              {entry.actorName ?? t('admin.audit.systemActor')}
            </span>
            <span className="text-text-secondary">{actionLabel(t, entry.action)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="rounded bg-surface-container px-2 py-0.5 text-text-secondary">
              {t(CATEGORY_LABEL_KEYS[entry.category])}
            </span>
            {target ? <span>{t('admin.audit.target', { target })}</span> : null}
            {/* The server formats in its own time zone; the browser's wins without a hydration error. */}
            <time dateTime={entry.createdAt} suppressHydrationWarning>
              {formatDateTime(entry.createdAt, t.locale)}
            </time>
          </div>
          {entry.metadataText !== '{}' ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-text-secondary hover:text-text-primary">
                {t('admin.audit.metadata')}
              </summary>
              <pre className="mt-2 max-h-44 overflow-auto rounded-lg border border-border-subtle bg-surface-container p-3 text-xs text-text-secondary">
                {entry.metadataText}
              </pre>
            </details>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-xs text-text-muted" suppressHydrationWarning>
          {relativeTime(t, entry.timestamp)}
        </div>
      </div>
    </article>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'danger' | 'tertiary' | 'muted';
}) {
  const dotClass =
    tone === 'primary'
      ? 'bg-primary-container'
      : tone === 'danger'
        ? 'bg-danger'
        : tone === 'tertiary'
          ? 'bg-tertiary'
          : 'bg-text-muted';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className={`h-2 w-2 rounded-full ${dotClass}`} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function categorizeAction(action: string): Category {
  if (action.startsWith('ban.') || action.startsWith('moderation.') || action === 'kick') {
    return 'moderation';
  }
  if (action.startsWith('role.') || action.startsWith('member.')) return 'roles';
  if (action.startsWith('invite.')) return 'invites';
  if (action.startsWith('channel.')) return 'channels';
  if (action.startsWith('message.')) return 'messages';
  if (action.startsWith('activity.')) return 'activities';
  if (action.startsWith('update.') || action.startsWith('server.')) return 'system';
  return 'other';
}

function describeAction(action: string): {
  icon: string;
  tone: { classes: { bg: string; border: string; icon: string } };
  actionLabel: string;
} {
  const neutral = {
    classes: {
      bg: 'bg-surface-raised',
      border: 'border-border-subtle',
      icon: 'text-text-secondary',
    },
  };
  const danger = {
    classes: {
      bg: 'bg-danger/10',
      border: 'border-danger/30',
      icon: 'text-danger',
    },
  };
  const system = {
    classes: {
      bg: 'bg-primary-container/10',
      border: 'border-primary-container/30',
      icon: 'text-primary',
    },
  };

  if (action.startsWith('invite.')) return { icon: 'mail', tone: neutral, actionLabel: action.replace('invite.', '') };
  if (action.startsWith('ban.') || action.startsWith('moderation.') || action === 'kick') {
    return { icon: 'security', tone: danger, actionLabel: action.replace('moderation.', '') };
  }
  if (action.startsWith('role.') || action.startsWith('member.')) {
    return { icon: 'badge', tone: neutral, actionLabel: action.replace('role.', 'role ').replace('member.', 'member ') };
  }
  if (action.startsWith('channel.')) return { icon: 'forum', tone: neutral, actionLabel: action.replace('channel.', '') };
  if (action.startsWith('message.')) return { icon: 'chat', tone: neutral, actionLabel: action.replace('message.', '') };
  if (action.startsWith('activity.')) return { icon: 'sports_esports', tone: neutral, actionLabel: action.replace('activity.', '') };
  if (action.startsWith('update.') || action.startsWith('server.')) {
    return { icon: 'system_update', tone: system, actionLabel: action.replace('update.', '').replace('server.', 'server ') };
  }
  return { icon: 'history', tone: neutral, actionLabel: action };
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(sortJson(value ?? {}), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)])
    );
  }
  return value;
}

function formatCsvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function relativeTime(t: Translator, timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '';
  const ms = Date.now() - timestamp;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('admin.audit.ago.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('admin.audit.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('admin.audit.ago.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('admin.audit.ago.days', { count: days });
  return new Date(timestamp).toLocaleDateString(t.locale);
}

const TARGET_TYPES = ['card_pack', 'channel', 'invite', 'membership', 'message', 'plugin', 'role', 'server', 'session', 'user'];

/** What an audit entry acted on, in words; an unknown type shows as written. */
function targetTypeLabel(t: Translator, type: string): string {
  return TARGET_TYPES.includes(type) ? t(`admin.audit.targetType.${type}`) : type;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}
