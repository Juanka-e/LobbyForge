'use client';

import { useRef, useState } from 'react';
import type { UserRow } from '@lobbyforge/db';
import { ChangeAvatarModal } from '@/components/modals/ChangeAvatarModal';

export default function ProfileBody({
  user,
  serverProfile,
}: {
  user: UserRow | null;
  serverProfile: { serverName: string; nickname: string | null } | null;
}) {
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatarUrl ?? null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(user?.bannerUrl ?? null);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [statusText, setStatusText] = useState(user?.statusText ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [serverNickname, setServerNickname] = useState(serverProfile?.nickname ?? '');
  const [editing, setEditing] = useState<'displayName' | 'statusText' | 'bio' | 'serverNickname' | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);

  if (!user) {
    return (
      <section className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-text-primary">Profile</h1>
        <p className="mt-2 text-sm text-text-muted">Sign in to view your profile.</p>
      </section>
    );
  }

  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  async function saveAvatar({ croppedDataUrl }: { file: File; croppedDataUrl: string }) {
    setError(null);
    const res = await fetch('/api/users/me/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: croppedDataUrl }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `HTTP ${res.status}`);
    }
    const body = (await res.json()) as { avatarUrl: string };
    setAvatarUrl(body.avatarUrl);
  }

  async function saveBanner(dataUrl: string | null) {
    setBannerBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/users/me/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { bannerUrl: string | null };
      setBannerUrl(body.bannerUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBannerBusy(false);
    }
  }

  async function handleBannerFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setError('Banner must be a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setError('Banner image is too large. Choose an image under 6 MB.');
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read banner image.'));
      reader.readAsDataURL(file);
    });
    await saveBanner(dataUrl);
    if (bannerInputRef.current) bannerInputRef.current.value = '';
  }

  function beginEdit(field: 'displayName' | 'statusText' | 'bio' | 'serverNickname') {
    setEditing(field);
    setDraft(field === 'displayName' ? displayName : field === 'statusText' ? statusText : field === 'bio' ? bio : serverNickname);
    setError(null);
  }

  async function saveProfileField() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing === 'serverNickname') {
        const res = await fetch('/api/users/me/server-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: draft.trim() ? draft : null }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(detail.error ?? `HTTP ${res.status}`);
        }
        const payload = (await res.json()) as { serverProfile: { nickname: string | null } };
        setServerNickname(payload.serverProfile.nickname ?? '');
        setEditing(null);
        setDraft('');
        return;
      }
      const body = editing === 'displayName'
        ? { displayName: draft }
        : editing === 'bio'
          ? { bio: draft.trim() ? draft : null }
          : { statusText: draft.trim() ? draft : null };
      const res = await fetch('/api/users/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { user: { displayName: string; statusText: string | null; bio: string | null } };
      setDisplayName(payload.user.displayName);
      setStatusText(payload.user.statusText ?? '');
      setBio(payload.user.bio ?? '');
      setEditing(null);
      setDraft('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">Profile</h1>
          <p className="mt-1 text-sm text-text-secondary">
            How you appear to other members in this community.
          </p>
        </header>

        <div className="rounded-xl border border-border-subtle bg-surface overflow-hidden">
          <div
            className="relative h-36 bg-gradient-to-br from-primary/30 to-tertiary/20 bg-cover bg-center"
            style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
          >
            <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-black/10" />
            <div className="absolute right-4 top-4 flex gap-2">
              <input
                ref={bannerInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => void handleBannerFile(event.target.files?.[0])}
              />
              {bannerUrl ? (
                <button
                  type="button"
                  disabled={bannerBusy}
                  onClick={() => void saveBanner(null)}
                  className="rounded-md border border-white/20 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/60 disabled:opacity-50"
                >
                  Remove banner
                </button>
              ) : null}
              <button
                type="button"
                disabled={bannerBusy}
                onClick={() => bannerInputRef.current?.click()}
                className="rounded-md border border-white/20 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/60 disabled:opacity-50"
              >
                {bannerBusy ? 'Saving...' : bannerUrl ? 'Change banner' : 'Add banner'}
              </button>
            </div>
          </div>
          <div className="px-6 pb-6 -mt-12 flex items-end justify-between gap-4">
            <div className="size-24 rounded-full border-4 border-surface bg-surface-variant overflow-hidden flex items-center justify-center text-text-secondary text-2xl font-medium">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
                <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
              ) : (
                <span aria-hidden>{initial}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-raised transition-colors"
            >
              Change avatar
            </button>
          </div>
        </div>

        <Section title="Profile">
          <EditableRow
            label="Display name"
            value={displayName}
            editing={editing === 'displayName'}
            draft={draft}
            maxLength={64}
            busy={busy}
            onBegin={() => beginEdit('displayName')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
          <EditableRow
            label="Status"
            value={statusText || 'No status set'}
            editing={editing === 'statusText'}
            draft={draft}
            maxLength={128}
            busy={busy}
            onBegin={() => beginEdit('statusText')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
          <EditableRow
            label="About me"
            value={bio || 'No bio set'}
            editing={editing === 'bio'}
            draft={draft}
            maxLength={190}
            busy={busy}
            onBegin={() => beginEdit('bio')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
        </Section>

        <Section title="Server-specific">
          {serverProfile ? (
            <EditableRow
              label={`Nickname in ${serverProfile.serverName}`}
              value={serverNickname || `Default (${displayName})`}
              editing={editing === 'serverNickname'}
              draft={draft}
              maxLength={64}
              busy={busy}
              last
              onBegin={() => beginEdit('serverNickname')}
              onDraft={setDraft}
              onSave={saveProfileField}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Row label="Nickname" value="No accessible community" last />
          )}
        </Section>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <ChangeAvatarModal
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        currentAvatarUrl={avatarUrl}
        displayName={displayName}
        onSave={saveAvatar}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2">
        {title}
      </h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  badge,
  last = false,
}: {
  label: string;
  value: string;
  badge?: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex justify-between items-center ${
        last ? '' : 'border-b border-border-subtle pb-6'
      }`}
    >
      <div>
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
        <p className="text-sm text-text-primary">{value}</p>
      </div>
      {badge ? (
        <span className="px-2 py-1 rounded bg-surface-container-high text-text-muted text-[10px] uppercase tracking-wide">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function EditableRow({
  label,
  value,
  editing,
  draft,
  maxLength,
  busy,
  onBegin,
  onDraft,
  onSave,
  onCancel,
  last = false,
}: {
  label: string;
  value: string;
  editing: boolean;
  draft: string;
  maxLength: number;
  busy: boolean;
  onBegin: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  last?: boolean;
}) {
  return (
    <div className={`flex justify-between items-center gap-4 ${last ? '' : 'border-b border-border-subtle pb-6'}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
        {editing ? (
          <input
            value={draft}
            maxLength={maxLength}
            onChange={(event) => onDraft(event.target.value)}
            className="w-full max-w-md bg-surface-raised border border-border-strong rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
        ) : (
          <p className="text-sm text-text-primary truncate">{value}</p>
        )}
      </div>
      {editing ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="btn-secondary-sm disabled:opacity-40">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onSave} className="btn-primary-sm disabled:opacity-40">
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : (
        <button type="button" onClick={onBegin} className="btn-secondary-sm">
          Edit
        </button>
      )}
    </div>
  );
}
