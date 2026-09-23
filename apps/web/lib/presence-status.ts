/**
 * The user-selectable presence status and how every surface renders it.
 *
 * beta-review: the lobby only ever knew "present" vs "offline" — the
 * heartbeats hard-coded `status: 'online'`, so the status the API had
 * accepted since M19 (`online | idle | dnd | offline`) could never be
 * set from the UI, and the member list painted one green dot for
 * everyone. This module is the single source of truth for the four
 * statuses, their labels and their dot colors.
 */

export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/**
 * Message KEYS, not text.
 *
 * This module is imported by client components AND by server code, so it
 * cannot hold a hook and must not bake one language in. It names the
 * strings; the caller resolves them with its own translator
 * (`useT()` in a client component, `getTranslator()` on the server).
 *
 * `offline` is what Discord calls "invisible" when YOU pick it.
 */
export const PRESENCE_LABEL_KEYS: Record<PresenceStatus, string> = {
  online: 'lobby.presence.online.label',
  idle: 'lobby.presence.idle.label',
  dnd: 'lobby.presence.dnd.label',
  offline: 'lobby.presence.offline.label',
};

export const PRESENCE_DESCRIPTION_KEYS: Record<PresenceStatus, string> = {
  online: 'lobby.presence.online.description',
  idle: 'lobby.presence.idle.description',
  dnd: 'lobby.presence.dnd.description',
  offline: 'lobby.presence.offline.description',
};

/**
 * @deprecated English-only fallback for the surfaces that have not been
 * migrated to `PRESENCE_LABEL_KEYS` yet (the member roster). Reach for
 * the key map plus a translator in anything new; delete this once the
 * last caller is gone.
 */
export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Invisible',
};

export const PRESENCE_ICONS: Record<PresenceStatus, string> = {
  online: 'check_circle',
  idle: 'bedtime',
  dnd: 'do_not_disturb_on',
  offline: 'visibility_off',
};

/** Tailwind background class for the status dot. */
export const PRESENCE_DOT_CLASS: Record<PresenceStatus, string> = {
  online: 'bg-success',
  idle: 'bg-tertiary',
  dnd: 'bg-danger',
  offline: 'bg-text-muted',
};

export function isPresenceStatus(value: unknown): value is PresenceStatus {
  return typeof value === 'string' && (PRESENCE_STATUSES as readonly string[]).includes(value);
}

/**
 * Coerce whatever a presence snapshot carries into a renderable status.
 * `hidden` is what the privacy projection emits for users who hide their
 * online status — to a viewer they are indistinguishable from offline.
 */
export function toPresenceStatus(value: unknown, fallback: PresenceStatus = 'online'): PresenceStatus {
  if (value === 'hidden') return 'offline';
  return isPresenceStatus(value) ? value : fallback;
}

/** localStorage key holding the status the user last chose. */
export const PRESENCE_STORAGE_KEY = 'lobbyforge.presence.status';

export function readStoredPresenceStatus(): PresenceStatus {
  if (typeof window === 'undefined') return 'online';
  try {
    const raw = window.localStorage.getItem(PRESENCE_STORAGE_KEY);
    return isPresenceStatus(raw) ? raw : 'online';
  } catch {
    // Private mode / blocked site data — fall back to the default.
    return 'online';
  }
}

export function storePresenceStatus(status: PresenceStatus): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PRESENCE_STORAGE_KEY, status);
  } catch {
    // Non-fatal: the status still applies to this session's heartbeats.
  }
}
