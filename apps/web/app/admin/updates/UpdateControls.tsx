'use client';

import { useMemo, useState } from 'react';

type UpdateAction = 'dry-run' | 'apply' | 'rollback';

interface UpdateControlsProps {
  majorUpgrade: boolean;
  maintenanceMode: boolean;
  signatureVerified: boolean;
}

interface UpdateResponse {
  error?: string;
  detail?: string;
  policy?: {
    mode: string;
    allowed: boolean;
    failures: string[];
  };
  run?: {
    failures: string[];
    gates: Record<string, boolean>;
  };
  worker?: {
    status: string;
    failures: string[];
  };
  updateRun?: {
    id: string;
    status: string;
  };
  execution?: {
    status: string;
    failures: string[];
  };
  historyError?: string;
}

export default function UpdateControls({ majorUpgrade, maintenanceMode, signatureVerified }: UpdateControlsProps) {
  const [action, setAction] = useState<UpdateAction>('dry-run');
  const [adminConfirmed, setAdminConfirmed] = useState(false);
  const [majorConfirmed, setMajorConfirmed] = useState(false);
  const [execute, setExecute] = useState(false);
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UpdateResponse | null>(null);

  const canExecute = useMemo(
    () =>
      action !== 'dry-run' &&
      execute &&
      adminConfirmed &&
      (!majorUpgrade || majorConfirmed) &&
      typed === 'EXECUTE' &&
      maintenanceMode &&
      signatureVerified,
    [action, adminConfirmed, execute, maintenanceMode, majorConfirmed, majorUpgrade, signatureVerified, typed]
  );

  async function submit(requestExecute: boolean) {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          adminConfirmed,
          majorConfirmed,
          execute: requestExecute,
        }),
      });
      const data = (await res.json()) as UpdateResponse;
      setResult(data);
    } catch (err) {
      setResult({ error: 'Request failed', detail: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>Controls</h2>

      <div style={{ display: 'grid', gap: 12 }}>
        <label style={labelStyle}>
          Action
          <select value={action} onChange={(event) => setAction(event.target.value as UpdateAction)} style={inputStyle}>
            <option value="dry-run">Dry-run</option>
            <option value="apply">Apply</option>
            <option value="rollback">Rollback</option>
          </select>
        </label>

        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={adminConfirmed}
            onChange={(event) => setAdminConfirmed(event.target.checked)}
          />
          Admin confirmation
        </label>

        {majorUpgrade ? (
          <label style={checkStyle}>
            <input
              type="checkbox"
              checked={majorConfirmed}
              onChange={(event) => setMajorConfirmed(event.target.checked)}
            />
            Major upgrade confirmation
          </label>
        ) : null}

        <label style={checkStyle}>
          <input type="checkbox" checked={execute} onChange={(event) => setExecute(event.target.checked)} />
          Request live execution
        </label>

        <label style={labelStyle}>
          Type EXECUTE
          <input value={typed} onChange={(event) => setTyped(event.target.value)} style={inputStyle} />
        </label>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void submit(false)} disabled={loading} style={buttonStyle}>
            Preview
          </button>
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={loading || !canExecute}
            style={{
              ...buttonStyle,
              borderColor: canExecute ? '#e3b341' : '#1f242c',
              color: canExecute ? '#e3b341' : '#68717c',
            }}
          >
            Execute
          </button>
        </div>

        {!maintenanceMode && action !== 'dry-run' ? (
          <p style={warnStyle}>Maintenance mode must be enabled before apply or rollback.</p>
        ) : null}
        {!signatureVerified && action !== 'dry-run' ? (
          <p style={warnStyle}>A verified release signature is required before execution.</p>
        ) : null}
      </div>

      {result ? <ResultPanel result={result} /> : null}
    </section>
  );
}

function ResultPanel({ result }: { result: UpdateResponse }) {
  return (
    <section style={{ marginTop: 16, borderTop: '1px solid #1f242c', paddingTop: 16 }}>
      <h3 style={{ ...headingStyle, fontSize: 16 }}>Result</h3>
      {result.error ? <p style={{ color: '#e36049' }}>{result.error}: {result.detail}</p> : null}
      {result.policy ? (
        <p style={{ color: result.policy.allowed ? '#5ad48a' : '#e3b341' }}>
          Policy {result.policy.mode} - {result.policy.allowed ? 'allowed' : 'locked'}
        </p>
      ) : null}
      {result.execution ? (
        <p style={{ color: result.execution.status === 'succeeded' ? '#5ad48a' : '#e3b341' }}>
          Execution {result.execution.status}
        </p>
      ) : null}
      {result.updateRun ? (
        <p>
          <a href={`/admin/updates/${result.updateRun.id}`} style={{ color: '#8fb7ff' }}>
            Open run details
          </a>
        </p>
      ) : null}
      {result.policy?.failures?.length ? (
        <ul>
          {result.policy.failures.map((failure) => (
            <li key={failure} style={{ color: '#e3b341' }}>{failure}</li>
          ))}
        </ul>
      ) : null}
      {result.historyError ? <p style={{ color: '#e3b341' }}>History warning: {result.historyError}</p> : null}
    </section>
  );
}

const sectionStyle = {
  border: '1px solid #1f242c',
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
} as const;

const headingStyle = { fontSize: 18, marginTop: 0 } as const;

const labelStyle = {
  display: 'grid',
  gap: 6,
  color: '#dce3ea',
} as const;

const checkStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: '#dce3ea',
} as const;

const inputStyle = {
  minHeight: 38,
  borderRadius: 6,
  border: '1px solid #1f242c',
  background: '#11151b',
  color: '#dce3ea',
  padding: '8px 10px',
} as const;

const buttonStyle = {
  border: '1px solid #263241',
  borderRadius: 6,
  background: '#11151b',
  color: '#dce3ea',
  minHeight: 38,
  padding: '8px 14px',
  cursor: 'pointer',
} as const;

const warnStyle = {
  margin: 0,
  color: '#e3b341',
} as const;
