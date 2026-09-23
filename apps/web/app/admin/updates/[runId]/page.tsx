import { cookies } from 'next/headers';
import { getSystemUpdateRunById, listSystemUpdateEvents } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import type { Translator } from '@/lib/i18n/core';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Same words as the updates list (`../page.tsx`); a page file cannot export them.
const RUN_STATUS_LABEL_KEYS: Record<string, string> = {
  planned: 'admin.updates.status.planned',
  locked: 'admin.updates.status.locked',
  running: 'admin.updates.status.running',
  succeeded: 'admin.updates.status.succeeded',
  failed: 'admin.updates.status.failed',
  rolled_back: 'admin.updates.status.rolled_back',
  blocked: 'admin.updates.status.blocked',
};

const RUN_ACTION_LABEL_KEYS: Record<string, string> = {
  'dry-run': 'admin.updates.action.dryRun',
  apply: 'admin.updates.action.apply',
  rollback: 'admin.updates.action.rollback',
};

function labelFor(t: Translator, keys: Record<string, string>, value: string): string {
  const key = keys[value];
  return key ? t(key) : value;
}

interface PageProps {
  params: Promise<{ runId: string }>;
}

export default async function UpdateRunPage({ params }: PageProps) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  const t = await getTranslator();
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>{t('admin.updates.run.title')}</h1>
        <p style={{ color: '#e36049' }}>{t('common.adminRequired')}</p>
      </section>
    );
  }

  const { runId } = await params;
  const [run, events] = await Promise.all([
    getSystemUpdateRunById(getDb(), runId),
    listSystemUpdateEvents(getDb(), runId),
  ]);
  if (!run) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>{t('admin.updates.run.title')}</h1>
        <p style={{ color: '#e36049' }}>{t('admin.updates.run.notFound')}</p>
        <p>
          <a href="/admin/updates" style={{ color: '#8fb7ff' }}>
            {t('admin.updates.run.back')}
          </a>
        </p>
      </section>
    );
  }

  const rollbackCommand = typeof run.plan.rollbackCommand === 'string' ? run.plan.rollbackCommand : null;

  return (
    <section>
      <p>
        <a href="/admin/updates" style={{ color: '#8fb7ff' }}>
          {t('admin.updates.run.back')}
        </a>
      </p>
      <h1 style={{ marginTop: 0 }}>{t('admin.updates.run.title')}</h1>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
          margin: '16px 0 24px',
        }}
      >
        <Badge
          label={t('admin.updates.run.status')}
          value={labelFor(t, RUN_STATUS_LABEL_KEYS, run.status)}
          tone={statusTone(run.status)}
        />
        <Badge
          label={t('admin.updates.run.action')}
          value={labelFor(t, RUN_ACTION_LABEL_KEYS, run.action)}
          tone="warn"
        />
        <Badge
          label={t('admin.updates.run.version')}
          value={t('admin.updates.run.versionRange', { from: run.fromVersion, to: run.toVersion })}
          tone="ok"
        />
        <Badge
          label={t('admin.updates.run.backup')}
          value={run.backupId ?? t('admin.updates.value.none')}
          tone={run.backupId ? 'ok' : 'warn'}
        />
      </div>

      {run.failures.length > 0 ? (
        <section style={sectionStyle}>
          <h2 style={headingStyle}>{t('admin.updates.run.failures')}</h2>
          <ul>
            {run.failures.map((failure) => (
              <li key={failure} style={{ color: '#e3b341' }}>{failure}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={headingStyle}>{t('admin.updates.run.gates')}</h2>
        <pre style={preStyle}>{JSON.stringify(run.gates, null, 2)}</pre>
      </section>

      {rollbackCommand ? (
        <section style={sectionStyle}>
          <h2 style={headingStyle}>{t('admin.updates.run.rollbackCommand')}</h2>
          <pre style={preStyle}>{rollbackCommand}</pre>
        </section>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={headingStyle}>{t('admin.updates.run.events')}</h2>
        {events.length > 0 ? (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {events.map((event) => (
              <li key={event.id} style={{ borderTop: '1px solid #1f242c', padding: '10px 0' }}>
                <span style={{ color: eventTone(event.level), fontSize: 12 }}>{event.level}</span>
                <strong style={{ display: 'block', color: '#dce3ea' }}>{event.message}</strong>
                <span style={{ color: '#9aa3ad', fontSize: 12 }}>
                  {event.createdAt.toISOString()}
                  {event.stepId ? ` - ${event.stepId}` : ''}
                </span>
                {Object.keys(event.metadata).length > 0 ? (
                  <pre style={{ ...preStyle, marginTop: 8 }}>{JSON.stringify(event.metadata, null, 2)}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: '#9aa3ad' }}>{t('admin.updates.run.noEvents')}</p>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={headingStyle}>{t('admin.updates.run.planSnapshot')}</h2>
        <pre style={preStyle}>{JSON.stringify(run.plan, null, 2)}</pre>
      </section>
    </section>
  );
}

const sectionStyle = {
  border: '1px solid #1f242c',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
} as const;

const headingStyle = { fontSize: 18, marginTop: 0 } as const;

const preStyle = {
  margin: 0,
  padding: 12,
  background: '#11151b',
  border: '1px solid #1f242c',
  borderRadius: 6,
  overflowX: 'auto',
  color: '#dce3ea',
} as const;

function Badge({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? '#5ad48a' : tone === 'warn' ? '#e3b341' : '#e36049';
  return (
    <div style={{ border: '1px solid #1f242c', borderRadius: 8, padding: 12 }}>
      <span style={{ color: '#9aa3ad', fontSize: 12 }}>{label}</span>
      <strong style={{ display: 'block', color, fontSize: 18, overflowWrap: 'anywhere' }}>{value}</strong>
    </div>
  );
}

function statusTone(status: string): 'ok' | 'warn' | 'bad' {
  if (status === 'succeeded' || status === 'rolled_back') return 'ok';
  if (status === 'failed') return 'bad';
  return 'warn';
}

function eventTone(level: string): string {
  if (level === 'error') return '#e36049';
  if (level === 'warn') return '#e3b341';
  if (level === 'debug') return '#8fb7ff';
  return '#5ad48a';
}
