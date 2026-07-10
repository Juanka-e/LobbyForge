'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';

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

const SCOPE_OPTIONS: { value: VisibilityScope; label: string; description: string }[] = [
  { value: 'everyone', label: 'Everyone', description: 'Public - visible in the registry and to non-members.' },
  { value: 'server_members', label: 'Server members', description: 'Only people who belong to the same community.' },
  { value: 'nobody', label: 'Nobody', description: 'Hide completely. You appear offline to everyone.' },
];

const TOGGLE_ROWS: { key: PrivacyToggleKey; label: string; description: string; icon: string }[] = [
  {
    key: 'showCurrentGame',
    label: 'Current game',
    description: 'Show active game sessions (Hushle, Quiz, Vampire Village).',
    icon: 'stadia_controller',
  },
  {
    key: 'showMusicStatus',
    label: 'Music status',
    description: 'Show when a music bot or shared audio activity is playing.',
    icon: 'music_note',
  },
  {
    key: 'showWatchPartyStatus',
    label: 'Watch party',
    description: 'Show watch-party participation in your activity text.',
    icon: 'theaters',
  },
  {
    key: 'showServerNameInActivity',
    label: 'Server name',
    description: 'Include the community name in public activity text.',
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
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');
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
          setStatus('Ready');
        }
      } catch {
        if (!cancelled) setStatus('Failed to load settings.');
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
    setStatus('Saving...');
    try {
      const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacy }),
      });
      setPrivacy(data.settings.privacy);
      setUpdatedAt(data.settings.updatedAt);
      setDirty(false);
      setStatus('Saved');
    } catch {
      setStatus('Failed to save.');
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
          <h1 className="text-2xl font-semibold text-text-primary">Privacy &amp; Activity</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Control who can see your profile, online status, and activity. Changes apply across every
            community on this instance.
          </p>
        </header>

        {/* Visibility scopes */}
        <Section title="Visibility" icon="visibility">
          <ScopeRow
            label="Profile visibility"
            description="Who can view your display name, avatar, and profile page."
            value={privacy ? coerceScope(privacy.profileVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ profileVisibility: value })}
          />
          <ScopeRow
            label="Online status"
            description="Who can see when you are online or in a voice channel."
            value={privacy ? coerceScope(privacy.onlineStatusVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ onlineStatusVisibility: value })}
          />
          <ScopeRow
            label="Activity status"
            description="Who can see what game or activity you are currently doing."
            value={privacy ? coerceScope(privacy.activityVisibility) : 'server_members'}
            disabled={!privacy}
            onChange={(value) => patchPrivacy({ activityVisibility: value })}
            last
          />
        </Section>

        {/* Activity kind toggles */}
        <Section title="Activity Details" icon="tune">
          {TOGGLE_ROWS.map((row, idx) => (
            <ToggleRow
              key={row.key}
              icon={row.icon}
              label={row.label}
              description={row.description}
              checked={privacy?.[row.key] ?? false}
              disabled={!privacy}
              onChange={(value) => patchPrivacy({ [row.key]: value } as Pick<PrivacySettings, typeof row.key>)}
              last={idx === TOGGLE_ROWS.length - 1}
            />
          ))}
        </Section>

        {/* Blocked users */}
        <Section title="Blocked Users" icon="block">
          {blocks.length === 0 ? (
            <div className="flex items-center gap-3 py-2">
              <span className="material-symbols-outlined text-success text-[18px]">check_circle</span>
              <p className="text-sm text-text-secondary">
                You haven&apos;t blocked anyone. Blocked users&apos; messages appear as
                &ldquo;Blocked user&rdquo; in chat - the message stays but the content is hidden.
              </p>
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
                    {unblockBusy === b.blockedUserId ? 'Unblocking...' : 'Unblock'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Info note */}
        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">info</span>
          <p className="text-xs text-text-muted leading-relaxed">
            These settings only affect this self-hosted instance. They are stored in the local
            PostgreSQL database and apply across every community you belong to on this server.
          </p>
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
              title={option.description}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                value === option.value
                  ? 'bg-surface-raised text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {option.label}
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

