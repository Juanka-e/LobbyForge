'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ServerNicknameRow, UserRow } from '@lobbyforge/db';
import { ChangeAvatarModal } from '@/components/modals/ChangeAvatarModal';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { initialOf } from '@/lib/initial';
import {
  ACCENT_COLOR_PRESETS,
  normalizeAccentColor,
  normalizeUsername,
  PRONOUNS_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PROBLEM_KEYS,
  usernameProblem,
  type UsernameProblem,
} from '@/lib/profile-fields';
import { RESTRICTED_ACTION_KEYS } from '@/components/email-verification/email-status';
import { handleEmailUnverified } from '@/components/email-verification/email-status-store';
import EmailUnverifiedNotice, { useEmailRestriction } from '@/components/email-verification/EmailUnverifiedNotice';

type EditableField = 'displayName' | 'statusText' | 'bio' | 'pronouns' | 'serverNickname';

/** A refused save, in the viewer's language — never the server's English text. */
function saveErrorMessage(t: Translator, status: number, detail: { code?: string }): string {
  const code = detail.code ?? '';
  if (code.startsWith('username_')) {
    const key = USERNAME_PROBLEM_KEYS[code.slice('username_'.length) as keyof typeof USERNAME_PROBLEM_KEYS];
    if (key) return t(key);
  }
  switch (code) {
    case 'pronouns_too_long':
      return t('settings.profile.pronouns.tooLong', { max: PRONOUNS_MAX_LENGTH });
    case 'pronouns_characters':
      return t('settings.profile.pronouns.characters');
    case 'accent_color_invalid':
      return t('settings.profile.accent.invalid');
    case 'invalid_nickname':
      return t('settings.profile.server.invalid');
    case 'no_community':
      return t('settings.profile.server.noCommunity');
    case 'invalid_profile':
      return t('settings.profile.error.invalid');
    default:
      return t('settings.profile.error.generic', { status });
  }
}

export default function ProfileBody({
  user,
  communities,
  initialServerId,
}: {
  user: UserRow | null;
  /** The account's nickname in each community it belongs to. */
  communities: ServerNicknameRow[];
  /** The community picked first: the lobby's (`?server=`), else the first by name. */
  initialServerId: string | null;
}) {
  const t = useT();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatarUrl ?? null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(user?.bannerUrl ?? null);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [statusText, setStatusText] = useState(user?.statusText ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [pronouns, setPronouns] = useState(user?.pronouns ?? '');
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [nicknames, setNicknames] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(communities.map((c) => [c.serverId, c.nickname]))
  );
  const [serverId, setServerId] = useState<string | null>(initialServerId);
  const [editing, setEditing] = useState<EditableField | 'username' | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [accentBusy, setAccentBusy] = useState(false);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);
  const communitySelectId = useId();
  // EMAIL.md §4.2: new avatar and banner images are uploads.
  const emailLock = useEmailRestriction({ enabled: Boolean(user && !user.isGuest) });

  if (!user) {
    return (
      <section className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.profile')}</h1>
        <p className="mt-2 text-sm text-text-muted">{t('settings.profile.signedOut')}</p>
      </section>
    );
  }

  const initial = initialOf(displayName, { locale: t.locale });
  // security-review FILE-001: guests cannot store images (the server
  // refuses with 403 guest_upload_forbidden); the controls say so up front.
  const isGuest = user.isGuest;
  const community = communities.find((c) => c.serverId === serverId) ?? null;
  const serverNickname = community ? (nicknames[community.serverId] ?? '') : '';

  /** A refused image upload, in the viewer's language where the server gave a reason code. */
  function uploadError(status: number, detail: { error?: string; code?: string }): Error {
    // EMAIL.md §4.2 (uploads): explained in the viewer's language.
    if (handleEmailUnverified(status, detail)) return new Error(t(RESTRICTED_ACTION_KEYS.upload));
    if (detail.code === 'guest_upload_forbidden') return new Error(t('settings.profile.guestImages'));
    if (detail.code === 'upload_budget_exceeded') return new Error(t('settings.profile.uploadBudgetExceeded'));
    return new Error(t('settings.profile.error.generic', { status }));
  }

  async function saveAvatar({ croppedDataUrl }: { file: File; croppedDataUrl: string }) {
    setError(null);
    const res = await fetch('/api/users/me/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: croppedDataUrl }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw uploadError(res.status, detail);
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
        const detail = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw uploadError(res.status, detail);
      }
      const body = (await res.json()) as { bannerUrl: string | null };
      setBannerUrl(body.bannerUrl);
    } catch (err) {
      setError(err instanceof TypeError ? t('settings.profile.error.network') : (err as Error).message);
    } finally {
      setBannerBusy(false);
    }
  }

  async function handleBannerFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setError(t('settings.profile.banner.badType'));
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setError(t('settings.profile.banner.tooLarge'));
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(t('settings.profile.banner.readFailed')));
      reader.readAsDataURL(file);
    });
    await saveBanner(dataUrl);
    if (bannerInputRef.current) bannerInputRef.current.value = '';
  }

  function beginEdit(field: EditableField | 'username') {
    setEditing(field);
    const current: Record<EditableField | 'username', string> = {
      displayName,
      statusText,
      bio,
      pronouns,
      username,
      serverNickname,
    };
    setDraft(current[field]);
    setError(null);
  }

  /** PATCH /api/users/me/profile; applies what the server stored. */
  async function patchProfile(body: Record<string, string | null>): Promise<boolean> {
    const res = await fetch('/api/users/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { code?: string };
      setError(saveErrorMessage(t, res.status, detail));
      return false;
    }
    const payload = (await res.json()) as {
      user: {
        displayName: string;
        statusText: string | null;
        bio: string | null;
        username?: string | null;
        pronouns?: string | null;
        accentColor?: string | null;
      };
    };
    setDisplayName(payload.user.displayName);
    setStatusText(payload.user.statusText ?? '');
    setBio(payload.user.bio ?? '');
    setUsername(payload.user.username ?? '');
    setPronouns(payload.user.pronouns ?? '');
    setAccentColor(payload.user.accentColor ?? null);
    return true;
  }

  async function saveProfileField() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing === 'serverNickname') {
        if (!community) return;
        const res = await fetch('/api/users/me/server-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: community.serverId, nickname: draft.trim() ? draft : null }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { code?: string };
          setError(saveErrorMessage(t, res.status, detail));
          return;
        }
        const payload = (await res.json()) as { serverProfile: { serverId: string; nickname: string | null } };
        setNicknames((current) => ({ ...current, [payload.serverProfile.serverId]: payload.serverProfile.nickname }));
        setEditing(null);
        setDraft('');
        return;
      }
      const text = draft.trim() ? draft : null;
      const body: Record<string, string | null> =
        editing === 'displayName'
          ? { displayName: draft }
          : editing === 'bio'
            ? { bio: text }
            : editing === 'pronouns'
              ? { pronouns: text }
              : editing === 'username'
                ? { username: text }
                : { statusText: text };
      if (await patchProfile(body)) {
        setEditing(null);
        setDraft('');
      }
    } catch {
      setError(t('settings.profile.error.network'));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccent(color: string | null) {
    if (color === accentColor) return;
    setAccentBusy(true);
    setError(null);
    try {
      await patchProfile({ accentColor: color });
    } catch {
      setError(t('settings.profile.error.network'));
    } finally {
      setAccentBusy(false);
    }
  }

  return (
    <>
      <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.profile')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('settings.profile.description')}</p>
        </header>

        <div className="rounded-xl border border-border-subtle bg-surface overflow-hidden" data-testid="profile-preview">
          <div
            className={`relative h-36 bg-cover bg-center ${bannerUrl || accentColor ? '' : 'bg-gradient-to-br from-primary/30 to-tertiary/20'}`}
            style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : accentColor ? { backgroundColor: accentColor } : undefined}
            data-preview-band={bannerUrl ? undefined : (accentColor ?? 'default')}
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
                  {t('settings.profile.banner.remove')}
                </button>
              ) : null}
              {isGuest ? null : (
                <button
                  type="button"
                  disabled={bannerBusy || emailLock.restricted}
                  onClick={() => bannerInputRef.current?.click()}
                  className="rounded-md border border-white/20 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/60 disabled:opacity-50"
                >
                  {t(
                    bannerBusy
                      ? 'settings.footer.saving'
                      : bannerUrl
                        ? 'settings.profile.banner.change'
                        : 'settings.profile.banner.add'
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="px-6 pb-6 -mt-12 flex items-end justify-between gap-4">
            <div className="flex min-w-0 items-end gap-4">
              <div
                className="size-24 flex-none rounded-full border-4 border-surface bg-surface-variant overflow-hidden flex items-center justify-center text-text-secondary text-2xl font-medium"
                style={accentColor ? { boxShadow: `0 0 0 2px ${accentColor}` } : undefined}
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
                  <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
                ) : (
                  <span aria-hidden>{initial}</span>
                )}
              </div>
              <div className="min-w-0 pb-1">
                <p className="truncate text-lg font-bold text-text-primary">{displayName}</p>
                <p className="truncate text-sm text-text-secondary" data-testid="profile-preview-handle">
                  {[username ? `@${username}` : null, pronouns || null].filter(Boolean).join(' · ') || '\u00a0'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              disabled={emailLock.restricted || isGuest}
              aria-describedby={isGuest ? 'profile-guest-images' : undefined}
              className="flex-none rounded-md border border-border-strong px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-raised transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('settings.profile.changeAvatar')}
            </button>
          </div>
        </div>
        {isGuest ? (
          <p id="profile-guest-images" className="text-sm text-text-secondary">
            {t('settings.profile.guestImages')}
          </p>
        ) : null}
        {emailLock.restricted ? <EmailUnverifiedNotice action="upload" /> : null}

        <Section title={t('settings.nav.user.profile')}>
          <EditableRow
            label={t('settings.profile.displayName')}
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
          <UsernameRow
            value={username}
            editing={editing === 'username'}
            draft={draft}
            busy={busy}
            isGuest={isGuest}
            onBegin={() => beginEdit('username')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
          <EditableRow
            label={t('settings.profile.pronouns.label')}
            value={pronouns || t('settings.profile.pronouns.empty')}
            editing={editing === 'pronouns'}
            draft={draft}
            maxLength={PRONOUNS_MAX_LENGTH}
            placeholder={t('settings.profile.pronouns.placeholder')}
            busy={busy}
            onBegin={() => beginEdit('pronouns')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
          <EditableRow
            label={t('settings.profile.status')}
            value={statusText || t('settings.profile.statusEmpty')}
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
            label={t('settings.profile.bio')}
            value={bio || t('settings.profile.bioEmpty')}
            editing={editing === 'bio'}
            draft={draft}
            maxLength={190}
            busy={busy}
            last
            onBegin={() => beginEdit('bio')}
            onDraft={setDraft}
            onSave={saveProfileField}
            onCancel={() => setEditing(null)}
          />
        </Section>

        <Section title={t('settings.profile.accent.title')}>
          <AccentPicker value={accentColor} busy={accentBusy} onPick={(color) => void saveAccent(color)} />
        </Section>

        <Section title={t('settings.profile.server.title')}>
          {community ? (
            <>
              {communities.length > 1 ? (
                <div className="flex flex-col gap-1.5 border-b border-border-subtle pb-6 sm:flex-row sm:items-center sm:justify-between">
                  <label htmlFor={communitySelectId} className="text-[10px] uppercase tracking-wider text-text-muted">
                    {t('settings.profile.server.pick')}
                  </label>
                  <select
                    id={communitySelectId}
                    value={community.serverId}
                    onChange={(event) => {
                      setServerId(event.target.value);
                      if (editing === 'serverNickname') setEditing(null);
                    }}
                    className="w-full max-w-xs rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {communities.map((c) => (
                      <option key={c.serverId} value={c.serverId}>
                        {c.serverName}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <EditableRow
                label={t('settings.profile.server.nicknameIn', { server: community.serverName })}
                value={serverNickname || t('settings.profile.server.nicknameDefault', { name: displayName })}
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
            </>
          ) : (
            <Row label={t('settings.profile.server.nickname')} value={t('settings.profile.server.none')} last />
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
  placeholder,
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
  placeholder?: string;
  busy: boolean;
  onBegin: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  last?: boolean;
}) {
  const t = useT();
  return (
    <div className={`flex justify-between items-center gap-4 ${last ? '' : 'border-b border-border-subtle pb-6'}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
        {editing ? (
          <input
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-label={label}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) {
                event.preventDefault();
                onSave();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            }}
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
            {t('common.cancel')}
          </button>
          <button type="button" disabled={busy} onClick={onSave} className="btn-primary-sm disabled:opacity-40">
            {busy ? t('settings.footer.saving') : t('common.save')}
          </button>
        </div>
      ) : (
        <button type="button" onClick={onBegin} className="btn-secondary-sm" aria-label={`${t('settings.profile.edit')}: ${label}`}>
          {t('settings.profile.edit')}
        </button>
      )}
    </div>
  );
}

type Availability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; name: string }
  | { state: 'problem'; problem: UsernameProblem | 'taken' };

/** How long typing pauses before the handle is checked with the server. */
const USERNAME_CHECK_DELAY_MS = 400;

/**
 * The handle: `@` + the name, checked as it is typed — the format rules at
 * once, availability with the server after a short pause. Guests cannot
 * choose one (the route refuses too).
 */
function UsernameRow({
  value,
  editing,
  draft,
  busy,
  isGuest,
  onBegin,
  onDraft,
  onSave,
  onCancel,
}: {
  value: string;
  editing: boolean;
  draft: string;
  busy: boolean;
  isGuest: boolean;
  onBegin: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const label = t('settings.profile.username.label');
  const hintId = useId();
  const statusId = useId();
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });
  const normalized = normalizeUsername(draft);

  useEffect(() => {
    if (!editing) return;
    if (!normalized || normalized === value) {
      setAvailability({ state: 'idle' });
      return;
    }
    const problem = usernameProblem(normalized);
    if (problem) {
      setAvailability({ state: 'problem', problem });
      return;
    }
    setAvailability({ state: 'checking' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/users/me/username?name=${encodeURIComponent(normalized)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) return setAvailability({ state: 'idle' });
          const body = (await res.json()) as { available?: boolean; problem?: UsernameProblem | 'taken' | null };
          setAvailability(
            body.available ? { state: 'available', name: normalized } : { state: 'problem', problem: body.problem ?? 'taken' }
          );
        })
        .catch(() => {
          // Aborted by the next keystroke, or offline: the save answers anyway.
        });
    }, USERNAME_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editing, normalized, value]);

  const blocked = availability.state === 'problem' || availability.state === 'checking';
  return (
    <div className="flex justify-between items-start gap-4 border-b border-border-subtle pb-6">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
        {editing ? (
          <>
            <div className="flex w-full max-w-md items-center rounded-md border border-border-strong bg-surface-raised focus-within:ring-1 focus-within:ring-primary">
              <span className="pl-3 text-sm text-text-muted" aria-hidden>@</span>
              <input
                value={draft}
                maxLength={USERNAME_MAX_LENGTH}
                aria-label={label}
                aria-describedby={`${hintId} ${statusId}`}
                aria-invalid={availability.state === 'problem' || undefined}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => onDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy && !blocked) {
                    event.preventDefault();
                    onSave();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancel();
                  }
                }}
                className="w-full bg-transparent py-2 pl-1 pr-3 text-sm text-text-primary focus:outline-none"
                autoFocus
              />
            </div>
            <p id={hintId} className="mt-1.5 text-xs text-text-secondary">
              {t('settings.profile.username.hint')}
            </p>
            <p
              id={statusId}
              aria-live="polite"
              className={`mt-1 min-h-4 text-xs ${
                availability.state === 'problem' ? 'text-danger' : availability.state === 'available' ? 'text-success' : 'text-text-secondary'
              }`}
            >
              {availability.state === 'checking'
                ? t('settings.profile.username.checking')
                : availability.state === 'available'
                  ? t('settings.profile.username.available', { name: availability.name })
                  : availability.state === 'problem'
                    ? t(USERNAME_PROBLEM_KEYS[availability.problem])
                    : ''}
            </p>
          </>
        ) : (
          <p className="text-sm text-text-primary truncate">
            {value ? `@${value}` : t(isGuest ? 'settings.profile.username.guest' : 'settings.profile.username.empty')}
          </p>
        )}
      </div>
      {editing ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="btn-secondary-sm disabled:opacity-40">
            {t('common.cancel')}
          </button>
          <button type="button" disabled={busy || blocked} onClick={onSave} className="btn-primary-sm disabled:opacity-40">
            {busy ? t('settings.footer.saving') : t('common.save')}
          </button>
        </div>
      ) : isGuest ? null : (
        <button type="button" onClick={onBegin} className="btn-secondary-sm" aria-label={`${t('settings.profile.edit')}: ${label}`}>
          {t('settings.profile.edit')}
        </button>
      )}
    </div>
  );
}

/**
 * The profile colour: automatic (from the avatar), a swatch, or any colour.
 * A radio group — arrow keys move between the choices. Each pick saves.
 */
function AccentPicker({
  value,
  busy,
  onPick,
}: {
  value: string | null;
  busy: boolean;
  onPick: (color: string | null) => void;
}) {
  const t = useT();
  const descriptionId = useId();
  const customId = useId();
  const custom = value && !ACCENT_COLOR_PRESETS.includes(value) ? value : null;
  const [customDraft, setCustomDraft] = useState(custom ?? '#5865f2');
  const swatch =
    'relative grid size-9 place-items-center rounded-full border-2 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50';
  return (
    <div className="space-y-3" aria-busy={busy || undefined}>
      <p id={descriptionId} className="text-sm text-text-secondary">
        {t('settings.profile.accent.description')}
      </p>
      <div role="radiogroup" aria-describedby={descriptionId} aria-label={t('settings.profile.accent.title')} className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          disabled={busy}
          onClick={() => onPick(null)}
          title={t('settings.profile.accent.auto')}
          aria-label={t('settings.profile.accent.auto')}
          className={`${swatch} bg-gradient-to-br from-primary/40 to-tertiary/30 ${value === null ? 'border-text-primary' : 'border-transparent'}`}
        >
          <span className="material-symbols-outlined text-[18px] text-text-primary" aria-hidden>auto_awesome</span>
        </button>
        {ACCENT_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={value === color}
            disabled={busy}
            onClick={() => onPick(color)}
            title={color}
            aria-label={t('settings.profile.accent.swatch', { color })}
            className={`${swatch} ${value === color ? 'border-text-primary scale-110' : 'border-transparent'}`}
            style={{ backgroundColor: color }}
            data-accent-swatch={color}
          >
            {value === color ? (
              <span className="material-symbols-outlined text-[18px] text-white drop-shadow" aria-hidden>check</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={customId} className="text-sm text-text-secondary">
          {t('settings.profile.accent.custom')}
        </label>
        <input
          id={customId}
          type="color"
          value={customDraft}
          disabled={busy}
          onChange={(event) => setCustomDraft(event.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-border-strong bg-surface-raised p-0.5 disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || !normalizeAccentColor(customDraft) || normalizeAccentColor(customDraft) === value}
          onClick={() => onPick(normalizeAccentColor(customDraft))}
          className="btn-secondary-sm disabled:opacity-40"
        >
          {t('settings.profile.accent.useCustom')}
        </button>
        {custom ? <span className="text-xs text-text-secondary">{t('settings.profile.accent.current', { color: custom })}</span> : null}
      </div>
    </div>
  );
}
