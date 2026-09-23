'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter, { type SettingsStatus } from '@/app/settings/SettingsStickyFooter';
import { useT } from '@/lib/i18n/client';

/**
 * User Settings -> Privacy & Activity.
 *
 * The only privacy settings LobbyForge stores server-side. Controls
 * profile/online/activity visibility scopes + per-activity-kind
 * switches. All values persist through PATCH /api/settings/me {privacy}.
 *
 * Visibility scope 'friends' is in the enum for forward-compat but the
 * UI hides it today because LobbyForge has no friends system - the
 * three meaningful options are Everyone / Server members / Nobody.
 */

type VisibilityScope = 'everyone' | 'server_members' | 'nobody';

type PrivacySettings = {
  profileVisibility: string;
  onlineStatusVisibility: string;
  activityVisibility: string;
  showCurrentGame: boolean;
  showMusicStatus: boolean;
  showWatchPartyStatus: boolean;
  showServerNameInActivity: boolean;
};

type SettingsResponse = {
  settings: {
    theme: string;
    notifications: Record<string, unknown>;
    audio: Record<string, unknown>;
    privacy: PrivacySettings;
    keybinds: Record<string, unknown>;
    updatedAt: string;
  };
};

type PrivacyToggleKey =
  | 'showCurrentGame'
  | 'showMusicStatus'
  | 'showWatchPartyStatus'
  | 'showServerNameInActivity';

interface BlockedUser {
  blockedUserId: string;
  blockedDisplayName: string;
  blockedAvatarUrl: string | null;
  createdAt: string;
}

/** Coerce any API string into the 3 meaningful UI scopes. */
function coerceScope(value: string): VisibilityScope {
  if (value === 'everyone' || value === 'nobody') return value;
  return 'server_members';
}

// Labels are message keys, resolved where they render.
const SCOPE_OPTIONS: { value: VisibilityScope; labelKey: string; descriptionKey: string }[] = [
  { value: 'everyone', labelKey: 'settings.overview.scope.everyone', descriptionKey: 'settings.overview.scope.everyoneHint' },
  { value: 'server_members', labelKey: 'settings.overview.scope.members', descriptionKey: 'settings.overview.scope.membersHint' },
  { value: 'nobody', labelKey: 'settings.overview.scope.nobody', descriptionKey: 'settings.overview.scope.nobodyHint' },
];

const TOGGLE_ROWS: { key: PrivacyToggleKey; labelKey: string; descriptionKey: string; icon: string }[] = [
  {
    key: 'showCurrentGame',
    labelKey: 'settings.overview.details.game',
    descriptionKey: 'settings.overview.details.gameHint',
    icon: 'stadia_controller',
  },
  {
    key: 'showMusicStatus',
    labelKey: 'settings.overview.details.music',
    descriptionKey: 'settings.overview.details.musicHint',
    icon: 'music_note',
  },
  {
    key: 'showWatchPartyStatus',
    labelKey: 'settings.overview.details.watchParty',
    descriptionKey: 'settings.overview.details.watchPartyHint',
    icon: 'theaters',
  },
  {
    key: 'showServerNameInActivity',
    labelKey: 'settings.overview.details.serverName',
    descriptionKey: 'settings.overview.details.serverNameHint',
    icon: 'dns',
  },
];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export default function SettingsPage() {
  const t = useT();
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SettingsStatus>({ key: 'settings.footer.loading' });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [blocks, setBlocks] = useState<BlockedUser[]>([]);
  const [unblockBusy, setUnblockBusy] = useState<string | null>(null);

  const disabled = useMemo(() => busy || !privacy || !dirty, [busy, privacy, dirty]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let data: SettingsResponse;
        try {
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        } catch {
          await jsonFetch('/api/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        }
        if (!cancelled) {
          setPrivacy(data.settings.privacy);
          setUpdatedAt(data.settings.updatedAt);
          setStatus({ key: 'settings.footer.ready' });
        }
      } catch {
        if (!cancelled) setStatus({ key: 'settings.footer.loadFailed' });
      }
      // Fetch blocked users in parallel.
      try {
        const blocksRes = await jsonFetch<{ blocks: BlockedUser[] }>('/api/settings/me/blocks');
        if (!cancelled) setBlocks(blocksRes.blocks);
      } catch {
        // Non-fatal - the blocks section just shows empty.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function patchPrivacy(patch: Partial<PrivacySettings>) {
    setPrivacy((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  }

  async function save() {
    if (!privacy) return;
    setBusy(true);
    setStatus({ key: 'settings.footer.saving' });
    try {
      const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacy }),
      });
      setPrivacy(data.settings.privacy);
      setUpdatedAt(data.settings.updatedAt);
      setDirty(false);
      setStatus({ key: 'settings.footer.saved' });
    } catch {
      setStatus({ key: 'settings.footer.saveFailed' });
    } finally {
      setBusy(false);
    }
  }

  async function unblock(userId: string) {
    setUnblockBusy(userId);
    try {
      await fetch(`/api/settings/me/blocks/${userId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      setBlocks((prev) => prev.filter((b) => b.blockedUserId !== userId));
    } catch {
      /* swallow - the list refreshes on next page load */
    } finally {
      setUnblockBusy(null);
    }
  }

  return (
    <SettingsShell scope="user">
      <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.privacy')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('settings.overview.description')}</p>
        </header>

        {/* Visibility scopes */}
        <Section title={t('settings.overview.visibility.title')} icon="visibility">
          <ScopeRow
            label={t('settings.overview.visibility.profile')}
            description={t('settings.overview.visibility.profileHint')}
            value={privacy ? coerceScope(privacy.profileVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ profileVisibility: value })}
          />
          <ScopeRow
            label={t('settings.overview.visibility.online')}
            description={t('settings.overview.visibility.onlineHint')}
            value={privacy ? coerceScope(privacy.onlineStatusVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ onlineStatusVisibility: value })}
          />
          <ScopeRow
            label={t('settings.overview.visibility.activity')}
            description={t('settings.overview.visibility.activityHint')}
            value={privacy ? coerceScope(privacy.activityVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ activityVisibility: value })}
            last
          />
        </Section>

        {/* Activity kind toggles */}
        <Section title={t('settings.overview.details.title')} icon="tune">
          {TOGGLE_ROWS.map((row, idx) => (
            <ToggleRow
              key={row.key}
              icon={row.icon}
              label={t(row.labelKey)}
              description={t(row.descriptionKey)}
              checked={privacy?.[row.key] ?? false}
              disabled={!privacy}
              onChange={(value) => patchPrivacy({ [row.key]: value } as Pick<PrivacySettings, typeof row.key>)}
              last={idx === TOGGLE_ROWS.length - 1}
            />
          ))}
        </Section>

        {/* Blocked users */}
        <Section title={t('settings.overview.blocked.title')} icon="block">
          {blocks.length === 0 ? (
            <div className="flex items-center gap-3 py-2">
              <span className="material-symbols-outlined text-success text-[18px]">check_circle</span>
              <p className="text-sm text-text-secondary">{t('settings.overview.blocked.empty')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {blocks.map((b) => (
                <div
                  key={b.blockedUserId}
                  className="flex items-center justify-between gap-3 p-2 rounded-md border border-border-subtle bg-surface-container-low"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center font-bold text-text-primary text-sm flex-shrink-0">
                      {b.blockedDisplayName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm text-text-primary font-medium truncate">
                      {b.blockedDisplayName}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => unblock(b.blockedUserId)}
                    disabled={unblockBusy === b.blockedUserId}
                    className="px-3 py-1.5 rounded-md border border-border-strong text-xs text-text-secondary hover:bg-surface-raised hover:text-danger hover:border-danger/40 transition-colors disabled:opacity-40 flex-shrink-0"
                  >
                    {unblockBusy === b.blockedUserId
                      ? t('settings.overview.blocked.unblocking')
                      : t('settings.overview.blocked.unblock')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Info note */}
        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">info</span>
          <p className="text-xs text-text-muted leading-relaxed">{t('settings.overview.note')}</p>
        </div>

        <SettingsStickyFooter
          status={status}
          updatedAt={updatedAt}
          dirty={dirty}
          busy={busy}
          onSave={save}
          saveDisabled={disabled}
        />
      </section>
    </SettingsShell>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold flex items-center gap-2">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {title}
      </h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-4">{children}</div>
    </section>
  );
}

function ScopeRow({
  label,
  description,
  value,
  disabled,
  onChange,
  last = false,
}: {
  label: string;
  description: string;
  value: VisibilityScope;
  disabled: boolean;
  onChange: (value: VisibilityScope) => void;
  last?: boolean;
}) {
  const t = useT();
  return (
    <div className={last ? '' : 'pb-4 border-b border-border-subtle'}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-text-primary font-medium">{label}</p>
          <p className="text-xs text-text-muted">{description}</p>
        </div>
        <div className="flex bg-surface-container rounded-lg p-1 border border-border-subtle flex-shrink-0">
          {SCOPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              title={t(option.descriptionKey)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                value === option.value
                  ? 'bg-surface-raised text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  disabled,
  onChange,
  last = false,
}: {
  icon: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 ${last ? '' : 'pb-4 border-b border-border-subtle'}`}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="material-symbols-outlined text-[18px] text-text-secondary mt-0.5 shrink-0">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-text-primary font-medium">{label}</p>
          <p className="text-xs text-text-muted">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full border transition-colors flex-shrink-0 ${
          checked ? 'bg-primary/20 border-primary' : 'bg-surface-container-high border-border-subtle'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span
          className={`absolute top-1 w-4 h-4 rounded-full transition-all ${
            checked ? 'right-1 bg-primary' : 'left-1 bg-text-muted'
          }`}
        />
      </button>
    </div>
  );
}

