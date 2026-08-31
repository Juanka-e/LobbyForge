'use client';

import { useRef, useState } from 'react';

/**
 * Instance logo management (Admin → Overview): upload / preview / remove.
 * POST /api/admin/instance-logo validates content-sniffed format
 * (GIF included) and dimensions (min 64×64, max 1024, 2 MB).
 */
export default function InstanceLogoCard({ initialLogoUrl }: { initialLogoUrl: string | null }) {
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function save(dataUrl: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/instance-logo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { instanceLogoUrl?: string | null; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setLogoUrl(body.instanceLogoUrl ?? null);
      setMessage(dataUrl ? 'Logo updated.' : 'Logo removed.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-sm p-6">
      <h2 className="text-base font-semibold text-text-primary">Instance logo</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Shown in the lobby header and as the browser tab icon. PNG, JPEG, GIF (animated works) or
        WebP — at least 64×64, at most 1024×1024 / 2 MB.
      </p>
      <div className="mt-4 flex items-center gap-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL
          <img src={logoUrl} alt="Instance logo" className="size-16 rounded-lg object-cover border border-border-subtle" />
        ) : (
          <div className="size-16 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center">
            <span className="material-symbols-outlined text-2xl text-text-muted">image</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="rounded-lg bg-primary-container px-4 py-2 font-label-sm text-on-primary-container hover:brightness-110 transition-all disabled:opacity-40"
          >
            {logoUrl ? 'Replace' : 'Upload logo'}
          </button>
          {logoUrl ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
              className="rounded-lg border border-danger/40 px-4 py-2 font-label-sm text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
            >
              Remove
            </button>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) {
              setMessage('Logo must be at most 2 MB.');
              return;
            }
            const reader = new FileReader();
            reader.onload = () => void save(String(reader.result));
            reader.onerror = () => setMessage('Could not read the file.');
            reader.readAsDataURL(file);
          }}
        />
      </div>
      {message ? <p className="mt-3 text-xs text-text-secondary">{message}</p> : null}
    </section>
  );
}
