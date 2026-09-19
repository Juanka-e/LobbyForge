/**
 * Server-side voice enforcement. Moderation decisions (server mute,
 * timeout, kick, ban, role / visibility changes) must hold against a
 * modified client, so they are pushed into LiveKit itself:
 *
 *   - the TOKEN route computes the publish grant with
 *     `buildAllowedPublishSources` (a rejoin cannot regain a revoked mic);
 *   - `syncMemberVoiceAccess` re-applies the same policy to a participant
 *     who is ALREADY connected (updateParticipant), or removes them from
 *     the room when they may no longer be there at all.
 *
 * Everything here is best-effort toward LiveKit: an unreachable SFU must
 * not fail the moderation action itself (the DB state is authoritative
 * and the token route enforces it on the next join).
 */
import { TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import {
  getActiveMemberTimeout,
  getEffectiveServerVoiceSettings,
  getServerById,
  getUserPermissions,
  isMemberVoiceMuted,
  isServerMember,
  listChannelsForServer,
} from '@lobbyforge/db';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getDb } from './db';
import { getRoomServiceClient } from './livekit';
import { liveKitRoomName } from './livekit-room';
import { authorizeChannelVisibility } from './permissions';

export type PublishSource = 'camera' | 'microphone' | 'screen-share' | 'screen-share-audio';

export interface PublishPolicyInput {
  allowCamera: boolean;
  allowScreenShare: boolean;
  memberPermissions: string[];
  timedOut: boolean;
  /** MUTE_MEMBERS server mute (memberships.voice_muted). */
  voiceMuted: boolean;
}

/** The sources a member may publish right now. */
export function buildAllowedPublishSources(
  policy: PublishPolicyInput,
  requested?: PublishSource[]
): PublishSource[] {
  const allowed = new Set<PublishSource>();
  if (hasPermission(policy.memberPermissions, CorePermission.SPEAK) && !policy.timedOut && !policy.voiceMuted) {
    allowed.add('microphone');
  }
  if (policy.allowCamera && hasPermission(policy.memberPermissions, CorePermission.STREAM)) {
    allowed.add('camera');
  }
  if (policy.allowScreenShare && hasPermission(policy.memberPermissions, CorePermission.STREAM)) {
    allowed.add('screen-share');
    allowed.add('screen-share-audio');
  }
  if (!requested) return Array.from(allowed);
  return requested.filter((source) => allowed.has(source));
}

const WIRE_SOURCE: Record<PublishSource, TrackSource> = {
  camera: TrackSource.CAMERA,
  microphone: TrackSource.MICROPHONE,
  'screen-share': TrackSource.SCREEN_SHARE,
  'screen-share-audio': TrackSource.SCREEN_SHARE_AUDIO,
};

/** The participant's published MICROPHONE track, if any (not camera / screen audio). */
export function findMicrophoneTrack(participant: ParticipantInfo) {
  return participant.tracks.find((t) => t.source === TrackSource.MICROPHONE);
}

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string | number; message?: string };
  return e?.status === 404 || e?.code === 'not_found' || /not.?found|does not exist/i.test(e?.message ?? '');
}

async function getParticipantOrNull(room: string, identity: string): Promise<ParticipantInfo | null> {
  try {
    return await getRoomServiceClient().getParticipant(room, identity);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Re-apply voice policy to `userId` in every voice/stage room of the
 * server they are currently connected to:
 *   - no longer a member / banned / lost CONNECT_VOICE / channel hidden
 *     → removed from the room;
 *   - otherwise → canPublishSources recomputed (server mute, timeout,
 *     SPEAK/STREAM and the server's camera/screen-share switches).
 * A revoked microphone is also muted immediately.
 */
export async function syncMemberVoiceAccess(serverId: string, userId: string): Promise<void> {
  const db = getDb();
  const voiceChannels = (await listChannelsForServer(db, serverId)).filter(
    (c) => c.type === 'voice' || c.type === 'stage'
  );
  if (voiceChannels.length === 0) return;

  const server = await getServerById(db, serverId);
  const isOwner = server?.ownerUserId === userId;
  const member = isOwner || (await isServerMember(db, userId, serverId));
  const permissions = member ? await getUserPermissions(db, userId, serverId) : [];
  const canConnect = member && hasPermission(permissions, CorePermission.CONNECT_VOICE);
  const settings = await getEffectiveServerVoiceSettings(db, serverId);
  const sources = buildAllowedPublishSources({
    allowCamera: settings.allowCamera,
    allowScreenShare: settings.allowScreenShare,
    memberPermissions: permissions,
    timedOut: member ? (await getActiveMemberTimeout(db, serverId, userId)) !== null : true,
    voiceMuted: member ? await isMemberVoiceMuted(db, serverId, userId) : true,
  });

  const lk = getRoomServiceClient();
  for (const channel of voiceChannels) {
    const room = liveKitRoomName(serverId, channel.id);
    try {
      const participant = await getParticipantOrNull(room, userId);
      if (!participant) continue;

      const visible =
        canConnect &&
        (await authorizeChannelVisibility(userId, serverId, channel.id, server?.ownerUserId ?? null)).ok;
      if (!visible) {
        await lk.removeParticipant(room, userId);
        continue;
      }

      if (!sources.includes('microphone')) {
        const mic = findMicrophoneTrack(participant);
        if (mic && !mic.muted) await lk.mutePublishedTrack(room, userId, mic.sid, true);
      }
      // Permissions are replaced atomically — carry the existing flags
      // and only swap the publish-source list.
      await lk.updateParticipant(room, userId, {
        permission: {
          ...participant.permission,
          canPublish: true,
          canSubscribe: true,
          canPublishSources: sources.map((s) => WIRE_SOURCE[s]),
        },
      });
    } catch (err) {
      if (isNotFound(err)) continue;
      console.error('[voice-moderation] sync failed:', room, (err as Error).message);
    }
  }
}

/** Fire-and-forget wrapper for routes: never throws, never blocks the response. */
export function queueMemberVoiceSync(serverId: string, userId: string): void {
  void syncMemberVoiceAccess(serverId, userId).catch((err) =>
    console.error('[voice-moderation] sync failed:', (err as Error).message)
  );
}

/**
 * Re-apply policy to EVERYONE connected to the server's voice rooms (or
 * only `channelIds`). Used after changes that affect many members at once:
 * role permission edits, role assignment, channel visibility overrides.
 */
export async function syncServerVoiceAccess(serverId: string, channelIds?: string[]): Promise<void> {
  const voiceChannels = (await listChannelsForServer(getDb(), serverId)).filter(
    (c) => (c.type === 'voice' || c.type === 'stage') && (!channelIds || channelIds.includes(c.id))
  );
  const identities = new Set<string>();
  const lk = getRoomServiceClient();
  for (const channel of voiceChannels) {
    try {
      for (const participant of await lk.listParticipants(liveKitRoomName(serverId, channel.id))) {
        identities.add(participant.identity);
      }
    } catch (err) {
      if (!isNotFound(err)) console.error('[voice-moderation] list failed:', (err as Error).message);
    }
  }
  for (const identity of identities) {
    await syncMemberVoiceAccess(serverId, identity);
  }
}

export function queueServerVoiceSync(serverId: string, channelIds?: string[]): void {
  void syncServerVoiceAccess(serverId, channelIds).catch((err) =>
    console.error('[voice-moderation] server sync failed:', (err as Error).message)
  );
}
