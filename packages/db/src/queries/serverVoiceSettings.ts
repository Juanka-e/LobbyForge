import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverVoiceSettings } from '../schema.js';

export interface ServerVoiceSettingsRow {
  serverId: string;
  defaultUserLimit: number | null;
  requirePushToTalk: boolean;
  startMuted: boolean;
  allowCamera: boolean;
  allowScreenShare: boolean;
  maxCameraUsersPerRoom: number | null;
  maxScreenShareUsersPerRoom: number | null;
  maxScreenShareHeight: number;
  maxScreenShareFps: number;
  updatedAt: Date;
}

export interface UpdateServerVoiceSettingsInput {
  defaultUserLimit?: number | null;
  requirePushToTalk?: boolean;
  startMuted?: boolean;
  allowCamera?: boolean;
  allowScreenShare?: boolean;
  maxCameraUsersPerRoom?: number | null;
  maxScreenShareUsersPerRoom?: number | null;
  maxScreenShareHeight?: number;
  maxScreenShareFps?: number;
}

export function defaultServerVoiceSettings(serverId: string): ServerVoiceSettingsRow {
  return {
    serverId,
    defaultUserLimit: null,
    requirePushToTalk: false,
    startMuted: false,
    allowCamera: true,
    allowScreenShare: true,
    maxCameraUsersPerRoom: null,
    maxScreenShareUsersPerRoom: null,
    maxScreenShareHeight: 1080,
    maxScreenShareFps: 30,
    updatedAt: new Date(0),
  };
}

export async function getEffectiveServerVoiceSettings(
  db: DbClient,
  serverId: string
): Promise<ServerVoiceSettingsRow> {
  const rows = await db
    .select({
      serverId: serverVoiceSettings.serverId,
      defaultUserLimit: serverVoiceSettings.defaultUserLimit,
      requirePushToTalk: serverVoiceSettings.requirePushToTalk,
      startMuted: serverVoiceSettings.startMuted,
      allowCamera: serverVoiceSettings.allowCamera,
      allowScreenShare: serverVoiceSettings.allowScreenShare,
      maxCameraUsersPerRoom: serverVoiceSettings.maxCameraUsersPerRoom,
      maxScreenShareUsersPerRoom: serverVoiceSettings.maxScreenShareUsersPerRoom,
      maxScreenShareHeight: serverVoiceSettings.maxScreenShareHeight,
      maxScreenShareFps: serverVoiceSettings.maxScreenShareFps,
      updatedAt: serverVoiceSettings.updatedAt,
    })
    .from(serverVoiceSettings)
    .where(eq(serverVoiceSettings.serverId, serverId))
    .limit(1);

  return rows[0] ?? defaultServerVoiceSettings(serverId);
}

export async function updateServerVoiceSettings(
  db: DbClient,
  serverId: string,
  input: UpdateServerVoiceSettingsInput
): Promise<ServerVoiceSettingsRow> {
  const patch = {
    serverId,
    ...(input.defaultUserLimit !== undefined ? { defaultUserLimit: input.defaultUserLimit } : {}),
    ...(input.requirePushToTalk !== undefined ? { requirePushToTalk: input.requirePushToTalk } : {}),
    ...(input.startMuted !== undefined ? { startMuted: input.startMuted } : {}),
    ...(input.allowCamera !== undefined ? { allowCamera: input.allowCamera } : {}),
    ...(input.allowScreenShare !== undefined ? { allowScreenShare: input.allowScreenShare } : {}),
    ...(input.maxCameraUsersPerRoom !== undefined ? { maxCameraUsersPerRoom: input.maxCameraUsersPerRoom } : {}),
    ...(input.maxScreenShareUsersPerRoom !== undefined
      ? { maxScreenShareUsersPerRoom: input.maxScreenShareUsersPerRoom }
      : {}),
    ...(input.maxScreenShareHeight !== undefined ? { maxScreenShareHeight: input.maxScreenShareHeight } : {}),
    ...(input.maxScreenShareFps !== undefined ? { maxScreenShareFps: input.maxScreenShareFps } : {}),
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(serverVoiceSettings)
    .values(patch)
    .onConflictDoUpdate({
      target: serverVoiceSettings.serverId,
      set: patch,
    })
    .returning({
      serverId: serverVoiceSettings.serverId,
      defaultUserLimit: serverVoiceSettings.defaultUserLimit,
      requirePushToTalk: serverVoiceSettings.requirePushToTalk,
      startMuted: serverVoiceSettings.startMuted,
      allowCamera: serverVoiceSettings.allowCamera,
      allowScreenShare: serverVoiceSettings.allowScreenShare,
      maxCameraUsersPerRoom: serverVoiceSettings.maxCameraUsersPerRoom,
      maxScreenShareUsersPerRoom: serverVoiceSettings.maxScreenShareUsersPerRoom,
      maxScreenShareHeight: serverVoiceSettings.maxScreenShareHeight,
      maxScreenShareFps: serverVoiceSettings.maxScreenShareFps,
      updatedAt: serverVoiceSettings.updatedAt,
    });
  if (!row) throw new Error('updateServerVoiceSettings: upsert returned no rows');
  return row;
}
