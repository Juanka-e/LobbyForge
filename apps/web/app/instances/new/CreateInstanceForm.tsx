'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function CreateInstanceForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const response = await fetch('/api/servers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      server?: { id: string };
    };
    if (!response.ok || !body.server) {
      setError(body.error ?? 'Instance could not be created.');
      setSaving(false);
      return;
    }
    router.push(`/servers/${body.server.id}`);
  }

  return (
    <form onSubmit={submit} className="grid gap-5 max-w-xl">
      <label className="grid gap-2 text-label-sm text-text-secondary">
        Community name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={2}
          maxLength={80}
          required
          autoFocus
          className="bg-surface border border-border-strong rounded-lg px-3 py-2.5 text-text-primary"
          placeholder="My community"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || name.trim().length < 2}
          className="bg-primary-container text-[#07101e] rounded-lg px-4 py-2.5 font-semibold disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create instance'}
        </button>
        <a href="/lobby" className="text-text-secondary hover:text-text-primary">Cancel</a>
      </div>
      {error ? <p className="text-danger text-sm" role="alert">{error}</p> : null}
    </form>
  );
}
