import { cookies } from 'next/headers';
import { getSystemUpdateRunById, listSystemUpdateEvents } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PageProps {
  params: Promise<{ runId: string }>;
}

export default async function UpdateRunPage({ params }: PageProps) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>Update Run</h1>
        <p style={{ color: '#e36049' }}>Admin token required.</p>
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
        <h1 style={{ marginTop: 0 }}>Update Run</h1>
        <p style={{ color: '#e36049' }}>Run not found.</p>
        <p>
          <a href="/admin/updates" style={{ color: '#8fb7ff' }}>Back to updates</a>
        </p>
      </section>
    );
  }

  const rollbackCommand = typeof run.plan.rollbackCommand === 'string' ? run.plan.rollbackCommand : null;

  return (
    <section>
      <p>
        <a href="/admin/updates" style={{ color: '#8fb7ff' }}>Back to updates</a>
      </p>
      <h1 style={{ marginTop: 0 }}>Update Run</h1>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
          margin: '16px 0 24px',
        }}
      >
        <Badge label="status" value={run.status} tone={statusTone(run.status)} />
        <Badge label="action" value={run.action} tone="warn" />
        <Badge label="version" value={`${run.fromVersion} to ${run.toVersion}`} tone="ok" />
        <Badge label="backup" value={run.backupId ?? 'none'} tone={run.backupId ? 'ok' : 'warn'} />
      </div>

      {run.failures.length > 0 ? (
        <section style={sectionStyle}>
          <h2 style={headingStyle}>Failures</h2>
          <ul>
            {run.failures.map((failure) => (
              <li key={failure} style={{ color: '#e3b341' }}>{failure}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={headingStyle}>Gates</h2>
        <pre style={preStyle}>{JSON.stringify(run.gates, null, 2)}</pre>
      </section>

      {rollbackCommand ? (
        <section style={sectionStyle}>
          <h2 style={headingStyle}>Rollback Command</h2>
          <pre style={preStyle}>{rollbackCommand}</pre>
        </section>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={headingStyle}>Events</h2>
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
          <p style={{ color: '#9aa3ad' }}>No events recorded.</p>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={headingStyle}>Plan Snapshot</h2>
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
