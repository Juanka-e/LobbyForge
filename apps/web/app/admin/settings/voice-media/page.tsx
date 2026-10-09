import type { Metadata } from 'next';
import { getEffectiveServerVoiceSettings, type ServerVoiceSettingsRow } from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import VoiceMediaClient, { type VoiceSettingsView } from './VoiceMediaClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('voiceMedia', 'adminSettings.voiceMedia.metaTitle');
}

export default async function VoiceMediaSettingsPage() {
  const access = await requireAdminSection('voiceMedia');
  const db = getDb();

  let serverId: string | null = null;
  let settings: ServerVoiceSettingsRow | null = null;
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const firstServer = access.server;
      if (firstServer) {
        serverId = firstServer.id;
        settings = await getEffectiveServerVoiceSettings(db, firstServer.id);
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <VoiceMediaClient
        serverId={serverId}
        initial={settings ? toView(settings) : null}
        loadError={loadError}
      />
    </SettingsShell>
  );
}

function toView(settings: ServerVoiceSettingsRow): VoiceSettingsView {
  return {
    serverId: settings.serverId,
    defaultUserLimit: settings.defaultUserLimit,
    requirePushToTalk: settings.requirePushToTalk,
    startMuted: settings.startMuted,
    allowCamera: settings.allowCamera,
    allowScreenShare: settings.allowScreenShare,
    maxCameraUsersPerRoom: settings.maxCameraUsersPerRoom,
    maxScreenShareUsersPerRoom: settings.maxScreenShareUsersPerRoom,
    maxScreenShareHeight: settings.maxScreenShareHeight,
    maxScreenShareFps: settings.maxScreenShareFps,
    updatedAt: settings.updatedAt.toISOString(),
  };
}
