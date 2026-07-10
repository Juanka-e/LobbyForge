import { cookies } from 'next/headers';
import {
  getEffectiveServerVoiceSettings,
  getInstanceSetupStatus,
  listServersForUser,
  type ServerVoiceSettingsRow,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import VoiceMediaClient, { type VoiceSettingsView } from './VoiceMediaClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Voice & Media - Community Settings',
};

export default async function VoiceMediaSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Voice & Media</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const db = getDb();
  const setup = await getInstanceSetupStatus(db);
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let serverId: string | null = null;
  let settings: ServerVoiceSettingsRow | null = null;
  let loadError: string | null = null;

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        serverId = firstServer.id;
        settings = await getEffectiveServerVoiceSettings(db, firstServer.id);
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community">
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
    updatedAt: settings.updatedAt.toISOString(),
  };
}
