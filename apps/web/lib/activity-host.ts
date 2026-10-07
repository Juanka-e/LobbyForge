/**
 * Who hosts an activity when its host has left the voice room.
 *
 * Applies to plugins that require voice (`catalog.requiresVoiceRoom`): for
 * them "the host is here" means "the host is in the activity's voice room"
 * (lib/activity-voice.ts). Poll and Dice Bot do not require voice, so their
 * host keeps the session wherever they are; anyone with START_ACTIVITY can
 * still end it.
 *
 *  (a) TRANSFER — once the host has been out of the voice room for
 *      HOST_TRANSFER_AFTER_MS (60 s), hosting (`game_sessions.created_by`,
 *      what the `host` action policy and the panel's `hostUserId` read)
 *      moves to the longest-present participant in the room: activity
 *      players (the session roster) first, then anyone else in the room,
 *      each group by how long they have been in voice. Same ordering as
 *      Watch Party's own hand-over when its host leaves; a plugin with its
 *      own host field follows through `onHostChange` (Watch Party does).
 *  (b) ABANDONED — once the host has been gone HOST_ABANDON_AFTER_MS
 *      (3 min), or past the 60 s grace when nobody in the room can take
 *      over, any voice participant may end the session (end route).
 *
 * LAZY AND DETERMINISTIC: nothing runs on a timer. The decision is taken
 * when somebody touches the session — an action, a state read (GET) or an
 * end request — from the LiveKit room (who is there, since when) and the
 * absence ledger (since when the host is gone). `decideActivityHost` is
 * the pure rule; `resolveActivityHost` reads the facts, applies a due
 * transfer under the session's write lock (a compare-and-swap on the old
 * host, so concurrent requests move it once), audits it
 * (`activity.host_transfer`) and tells open panels to re-read.
 */
import {
  getGameSessionById,
  GameSessionBusyError,
  isServerMember,
  listPlayersForSession,
  logAction,
  transferGameSessionHost,
  withGameSessionWriteLock,
  type DbClient,
  type GameSessionRow,
} from '@lobbyforge/db';
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { publishActivityStateChange } from './activity-bus';
import {
  isInVoice,
  observeVoiceAbsence,
  pluginRequiresVoice,
  type VoiceRoomParticipant,
  type VoiceRoomSnapshot,
} from './activity-voice';

/** A host out of the voice room this long hands hosting over. */
export const HOST_TRANSFER_AFTER_MS = 60_000;
/** A host out of the voice room this long has abandoned the session: any voice participant may end it. */
export const HOST_ABANDON_AFTER_MS = 180_000;

const TERMINAL = new Set(['ended', 'cancelled']);

/** What a viewer may know about the host's presence (no identities beyond the host's own id). */
export interface ActivityHostView {
  /** The host after any transfer this call made. */
  hostUserId: string | null;
  /** The host is in the activity's voice room. */
  inVoice: boolean;
  /** Since when (ms) the host has been out of the room; null while present or unknown. */
  awaySince: number | null;
  /** When hosting moves (ms); null while the host is present or nobody can take over. */
  transferAt: number | null;
  /** When any voice participant may end the session (ms); null while the host is present. */
  abandonAt: number | null;
  /** Any voice participant may end the session now. */
  abandoned: boolean;
}

export interface HostDecision {
  view: ActivityHostView;
  /** Who would take over, best first (excludes the host). */
  candidates: string[];
  /** Hosting should move now (to the first candidate who is still a member). */
  transferDue: boolean;
}

/**
 * The pure rule. `awaySince` is the absence ledger's answer for an absent
 * host (null = unknown, e.g. Redis down — then nothing is due); a session
 * without a host (`hostUserId` null: the account is gone) counts as long
 * abandoned.
 */
export function decideActivityHost(input: {
  hostUserId: string | null;
  participants: readonly VoiceRoomParticipant[];
  rosterUserIds: readonly string[];
  awaySince: number | null;
  now: number;
}): HostDecision {
  const { hostUserId, participants, now } = input;
  const roster = new Set(input.rosterUserIds);
  const candidates = participants
    .filter((p) => p.userId !== hostUserId)
    .map((p, index) => ({ p, index, onRoster: roster.has(p.userId) }))
    // Players first, then the longest in the room (participants arrive oldest first).
    .sort((a, b) => Number(b.onRoster) - Number(a.onRoster) || a.index - b.index)
    .map((entry) => entry.p.userId);
  const inVoice = hostUserId !== null && participants.some((p) => p.userId === hostUserId);
  const present: HostDecision = {
    view: { hostUserId, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
    candidates,
    transferDue: false,
  };
  if (inVoice) return present;

  const canTransfer = candidates.length > 0;
  if (hostUserId === null) {
    // No host at all (the creator's account is gone): hand over at once,
    // and the room may end it meanwhile.
    return {
      view: { hostUserId, inVoice: false, awaySince: null, transferAt: canTransfer ? now : null, abandonAt: now, abandoned: true },
      candidates,
      transferDue: canTransfer,
    };
  }
  const awaySince = input.awaySince;
  if (awaySince === null) {
    return {
      view: { hostUserId, inVoice: false, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
      candidates,
      transferDue: false,
    };
  }
  const away = now - awaySince;
  const transferAt = canTransfer ? awaySince + HOST_TRANSFER_AFTER_MS : null;
  // Nobody to hand over to: the grace period is all the room waits.
  const abandonAt = awaySince + (canTransfer ? HOST_ABANDON_AFTER_MS : HOST_TRANSFER_AFTER_MS);
  return {
    view: {
      hostUserId,
      inVoice: false,
      awaySince,
      transferAt,
      abandonAt,
      abandoned: now >= abandonAt,
    },
    candidates,
    transferDue: canTransfer && away >= HOST_TRANSFER_AFTER_MS,
  };
}

/** The JSON a viewer gets (ISO times). */
export function hostViewJson(view: ActivityHostView): Record<string, unknown> {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    userId: view.hostUserId,
    inVoice: view.inVoice,
    awaySince: iso(view.awaySince),
    transferAt: iso(view.transferAt),
    abandonAt: iso(view.abandonAt),
    abandoned: view.abandoned,
  };
}

export interface ResolveHostResult {
  view: ActivityHostView;
  /** Set when THIS call moved hosting. */
  transferred: { fromUserId: string | null; toUserId: string } | null;
}

type HostRow = Pick<GameSessionRow, 'id' | 'serverId' | 'channelId' | 'pluginId' | 'createdBy' | 'status'>;

async function isMember(db: DbClient, userId: string, serverId: string, ownerUserId: string | null): Promise<boolean> {
  if (ownerUserId && userId === ownerUserId) return true;
  try {
    return await isServerMember(db, userId, serverId);
  } catch {
    return false;
  }
}

/**
 * Read the facts, decide, and apply a due transfer. Returns null for a
 * plugin that does not require voice, a terminal session, or when the
 * voice room cannot be read (fail open: nothing changes).
 *
 * `skipTransferWhenAbandoned` is the end route's mode: a session the room
 * may already end is ended, not handed to someone first.
 */
export async function resolveActivityHost(input: {
  db: DbClient;
  row: HostRow;
  plugin: RegisteredGamePlugin;
  voice: VoiceRoomSnapshot | null;
  ownerUserId: string | null;
  now?: number;
  skipTransferWhenAbandoned?: boolean;
}): Promise<ResolveHostResult | null> {
  const { db, row, plugin, voice } = input;
  if (!pluginRequiresVoice(plugin) || !voice || !voice.available) return null;
  if (TERMINAL.has(row.status)) return null;
  const now = input.now ?? Date.now();
  const hostUserId = row.createdBy ?? null;
  const present = isInVoice(voice, hostUserId);

  let awaySince: number | null = null;
  if (hostUserId !== null) awaySince = await observeVoiceAbsence(voice.room, hostUserId, present, now);
  if (present) {
    return { view: decideActivityHost({ hostUserId, participants: voice.participants, rosterUserIds: [], awaySince, now }).view, transferred: null };
  }

  let rosterUserIds: string[] = [];
  try {
    rosterUserIds = (await listPlayersForSession(db, row.id)).map((p) => p.userId);
  } catch (err) {
    console.warn('[activity-host] roster read failed:', (err as Error).message);
  }
  const decision = decideActivityHost({ hostUserId, participants: voice.participants, rosterUserIds, awaySince, now });
  if (!decision.transferDue || (input.skipTransferWhenAbandoned && decision.view.abandoned)) {
    return { view: decision.view, transferred: null };
  }

  for (const candidate of decision.candidates) {
    if (!(await isMember(db, candidate, row.serverId, input.ownerUserId))) continue;
    let moved: GameSessionRow | null = null;
    try {
      moved = await withGameSessionWriteLock(db, row.id, async (tx, fresh) => {
        // Someone else moved it (or ended the session) since we read it.
        if (!fresh || TERMINAL.has(fresh.status) || (fresh.createdBy ?? null) !== hostUserId) return null;
        let state: Record<string, unknown> | undefined;
        if (plugin.onHostChange) {
          const current = plugin.migrateState ? await plugin.migrateState(fresh.state) : fresh.state;
          const next = await plugin.onHostChange(current, {
            previousHostId: hostUserId,
            nextHostId: candidate,
            now,
            reason: 'host_left_voice',
          });
          if (next !== current && next && typeof next === 'object') state = next as Record<string, unknown>;
        }
        return transferGameSessionHost(tx, row.id, { fromUserId: hostUserId, toUserId: candidate, state });
      });
    } catch (err) {
      // Busy (a burst of actions) or a plugin hook that threw: try again on
      // the next touch, never fail the caller's request over it.
      if (!(err instanceof GameSessionBusyError)) {
        console.warn('[activity-host] transfer failed:', (err as Error).message);
      }
      return { view: decision.view, transferred: null };
    }
    if (!moved) {
      // Lost the race: report the session as it stands now.
      const fresh = await getGameSessionById(db, row.id).catch(() => null);
      const current = fresh?.createdBy ?? null;
      return {
        view: {
          ...decision.view,
          hostUserId: current,
          inVoice: isInVoice(voice, current),
          ...(isInVoice(voice, current) ? { awaySince: null, transferAt: null, abandonAt: null, abandoned: false } : {}),
        },
        transferred: null,
      };
    }
    void logAction(db, {
      serverId: row.serverId,
      actorUserId: null,
      action: 'activity.host_transfer',
      targetType: 'session',
      targetId: row.id,
      metadata: {
        pluginId: row.pluginId,
        fromUserId: hostUserId,
        toUserId: candidate,
        reason: 'host_left_voice',
        awaySeconds: decision.view.awaySince === null ? null : Math.round((now - decision.view.awaySince) / 1000),
      },
    }).catch((err) => console.error('[audit] activity.host_transfer failed:', (err as Error).message));
    // The bus carries no identities: panels re-read the session (players
    // and host) on `rosterChanged`.
    publishActivityStateChange({
      serverId: row.serverId,
      sessionId: row.id,
      status: moved.status,
      revision: (moved as { revision?: number }).revision,
      publicSummary: { rosterChanged: true },
    });
    return {
      view: { hostUserId: candidate, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
      transferred: { fromUserId: hostUserId, toUserId: candidate },
    };
  }
  // Nobody in the room is (still) a member: "no host can be assigned".
  const abandonAt = decision.view.awaySince === null ? now : decision.view.awaySince + HOST_TRANSFER_AFTER_MS;
  return {
    view: { ...decision.view, transferAt: null, abandonAt, abandoned: now >= abandonAt },
    transferred: null,
  };
}
