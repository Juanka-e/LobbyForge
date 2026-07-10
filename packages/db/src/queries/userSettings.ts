import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { userSettings } from '../schema.js';

export type ActivityVisibilityScope = 'everyone' | 'server_members' | 'friends' | 'nobody';

export interface UserPrivacySettings {
  profileVisibility: ActivityVisibilityScope;
  onlineStatusVisibility: ActivityVisibilityScope;
  activityVisibility: ActivityVisibilityScope;
  showCurrentGame: boolean;
  showMusicStatus: boolean;
  showWatchPartyStatus: boolean;
  showServerNameInActivity: boolean;
}

export interface UserSettingsRow {
  id: string;
  userId: string;
  theme: string;
  notifications: Record<string, unknown>;
  audio: Record<string, unknown>;
  privacy: UserPrivacySettings;
  keybinds: Record<string, unknown>;
  updatedAt: Date;
}

export const DEFAULT_USER_PRIVACY_SETTINGS: UserPrivacySettings = {
  profileVisibility: 'server_members',
  onlineStatusVisibility: 'server_members',
  activityVisibility: 'server_members',
  showCurrentGame: true,
  showMusicStatus: true,
  showWatchPartyStatus: true,
  showServerNameInActivity: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asScope(value: unknown, fallback: ActivityVisibilityScope): ActivityVisibilityScope {
  return value === 'everyone' || value === 'server_members' || value === 'friends' || value === 'nobody'
    ? value
    : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeUserPrivacySettings(value: unknown): UserPrivacySettings {
  const input = asRecord(value);
  return {
    profileVisibility: asScope(input.profileVisibility, DEFAULT_USER_PRIVACY_SETTINGS.profileVisibility),
    onlineStatusVisibility: asScope(
      input.onlineStatusVisibility,
      DEFAULT_USER_PRIVACY_SETTINGS.onlineStatusVisibility
    ),
    activityVisibility: asScope(input.activityVisibility, DEFAULT_USER_PRIVACY_SETTINGS.activityVisibility),
    showCurrentGame: asBoolean(input.showCurrentGame, DEFAULT_USER_PRIVACY_SETTINGS.showCurrentGame),
    showMusicStatus: asBoolean(input.showMusicStatus, DEFAULT_USER_PRIVACY_SETTINGS.showMusicStatus),
    showWatchPartyStatus: asBoolean(
      input.showWatchPartyStatus,
      DEFAULT_USER_PRIVACY_SETTINGS.showWatchPartyStatus
    ),
    showServerNameInActivity: asBoolean(
      input.showServerNameInActivity,
      DEFAULT_USER_PRIVACY_SETTINGS.showServerNameInActivity
    ),
  };
}

function toRow(row: typeof userSettings.$inferSelect): UserSettingsRow {
  return {
    id: row.id,
    userId: row.userId,
    theme: row.theme,
    notifications: asRecord(row.notifications),
    audio: asRecord(row.audio),
    privacy: normalizeUserPrivacySettings(row.privacy),
    keybinds: asRecord(row.keybinds),
    updatedAt: row.updatedAt,
  };
}

export async function getUserSettings(db: DbClient, userId: string): Promise<UserSettingsRow | null> {
  const found = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return found[0] ? toRow(found[0]) : null;
}

export async function getEffectiveUserSettings(db: DbClient, userId: string): Promise<UserSettingsRow> {
  const existing = await getUserSettings(db, userId);
  if (existing) return existing;
  const inserted = await db
    .insert(userSettings)
    .values({
      userId,
      privacy: DEFAULT_USER_PRIVACY_SETTINGS,
    })
    .onConflictDoNothing({ target: userSettings.userId })
    .returning();
  if (inserted[0]) return toRow(inserted[0]);
  const raced = await getUserSettings(db, userId);
  if (raced) return raced;
  throw new Error('Failed to create user settings');
}

export async function updateUserPrivacySettings(
  db: DbClient,
  userId: string,
  privacy: UserPrivacySettings,
  now: Date = new Date()
): Promise<UserSettingsRow> {
  const updated = await db
    .insert(userSettings)
    .values({ userId, privacy, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { privacy, updatedAt: now },
    })
    .returning();
  return toRow(updated[0]);
}

/**
 * Update the user's theme. Themes are free-form strings bounded to
 * 32 chars in the schema. The caller is responsible for validating
 * the value — we don't restrict to an enum because design tokens
 * evolve faster than the schema can keep up.
 */
export async function updateUserTheme(
  db: DbClient,
  userId: string,
  theme: string,
  now: Date = new Date()
): Promise<UserSettingsRow> {
  const updated = await db
    .insert(userSettings)
    .values({ userId, theme, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { theme, updatedAt: now },
    })
    .returning();
  return toRow(updated[0]);
}

/**
 * Update the user's notification preferences. The value is a free-form
 * JSON blob so the UI can introduce new toggles without a migration.
 * The route layer is responsible for shape validation.
 */
export async function updateUserNotifications(
  db: DbClient,
  userId: string,
  notifications: Record<string, unknown>,
  now: Date = new Date()
): Promise<UserSettingsRow> {
  const updated = await db
    .insert(userSettings)
    .values({ userId, notifications, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { notifications, updatedAt: now },
    })
    .returning();
  return toRow(updated[0]);
}

/**
 * Update the user's audio (voice / video) preferences. Same
 * free-form JSON model as notifications.
 */
export async function updateUserAudio(
  db: DbClient,
  userId: string,
  audio: Record<string, unknown>,
  now: Date = new Date()
): Promise<UserSettingsRow> {
  const updated = await db
    .insert(userSettings)
    .values({ userId, audio, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { audio, updatedAt: now },
    })
    .returning();
  return toRow(updated[0]);
}

/**
 * Update the user's keybind preferences. Stored as JSON so new actions can
 * be added without migrations; route/UI validation keeps it flat and bounded.
 */
export async function updateUserKeybinds(
  db: DbClient,
  userId: string,
  keybinds: Record<string, unknown>,
  now: Date = new Date()
): Promise<UserSettingsRow> {
  const updated = await db
    .insert(userSettings)
    .values({ userId, keybinds, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { keybinds, updatedAt: now },
    })
    .returning();
  return toRow(updated[0]);
}
