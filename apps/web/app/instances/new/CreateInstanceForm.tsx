'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { buttonOutline, buttonPrimary } from '@/app/(marketing)/_components/styles';
import { useT } from '@/lib/i18n/client';

export default function CreateInstanceForm() {
  const t = useT();
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
      setError(body.error ?? t('hub.instances.new.failed'));
      setSaving(false);
      return;
    }
    router.push(`/servers/${body.server.id}`);
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <label className="grid gap-2 text-sm font-medium text-text-primary">
        {t('hub.instances.new.nameLabel')}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={2}
          maxLength={80}
          required
          autoFocus
          className="h-12 w-full rounded-xl border border-border-strong bg-surface px-3.5 text-[15px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-1 focus:ring-primary"
          placeholder={t('hub.instances.new.namePlaceholder')}
        />
      </label>
      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-text-primary">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving || name.trim().length < 2}
          className={`${buttonPrimary} h-12 rounded-[14px] px-6 text-[15px] disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {saving ? t('hub.instances.new.creating') : t('hub.instances.new.submit')}
        </button>
        {/* Back to the hub home, where the communities list lives. */}
        <Link href="/home" className={`${buttonOutline} h-12 rounded-[14px] px-6 text-[15px]`}>
          {t('common.cancel')}
        </Link>
      </div>
    </form>
  );
}
