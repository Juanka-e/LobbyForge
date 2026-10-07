import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addPlayerToSession,
  GameSessionBusyError,
  getGameSessionById,
  getServerById,
  getUserPermissions,
  isServerMember,
  listPlayersForSession,
  logAction,
  setGameSessionStateCAS,
  withGameSessionWriteLock,
} from '@lobbyforge/db';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { shouldAuditAction, type GamePluginActionPolicy } from '@lobbyforge/plugin-sdk';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getPluginServer } from '@/lib/plugin-server-registry';
import { projectStateForViewer, sandboxLocaleFor } from '@/lib/plugin-projection';
import { attachSandboxScope, isWorkerBackedPlugin } from '@/lib/plugin-worker-client';
import { buildHttpPluginContext, callHandleAction } from '@/lib/plugin-context';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeSessionChannelVisibility } from '@/lib/permissions';
import { publishActivityStateChange } from '@/lib/activity-bus';
import { preparePluginAction } from '@/lib/prepare-plugin-action';
import {
  ActionClaim,
  DuplicateActionError,
  claimActionId,
  isValidActionId,
  releaseActionId,
} from '@/lib/action-idempotency';
import { activityError } from '@/lib/activity-errors';
import { getVoiceRoomSnapshot, isInVoice, pluginRequiresVoice, type VoiceRoomSnapshot } from '@/lib/activity-voice';
import { resolveActivityHost } from '@/lib/activity-host';
import { distributedRateLimit, rateLimitResponse, type RateLimitConfig } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Actions per user per session. The route's own limit (below, in
 * withApiSecurity) is per client ADDRESS — a household or a LAN party
 * shares one — so it is only a generous backstop; this is the real one.
 * A fast Hushle host scores a card every second or two.
 */
const ACTION_USER_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 90 };
/** The per-address backstop: a dozen people behind one NAT, all playing at full speed. */
const ACTION_ADDRESS_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 600 };

/** Session row statuses after which no action may be applied. */
const TERMINAL_SESSION_STATUSES = new Set(['ended', 'cancelled']);

function isTerminalSessionStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_SESSION_STATUSES.has(status);
}

const ActionSchema = z.object({
  type: z.string().min(1).max(64),
  // Action-specific fields are accepted but the host does not
  // validate them — the plugin's handleAction decides what's
  // meaningful for its own action union.
});

/**
 * The plugin's policy for an action type, host-only by default. Own
 * properties only: a plain index let `type: "constructor"` resolve to
 * Object.prototype's function — no `role`, so neither the host nor the
 * player check applied.
 */
function actionPolicyFor(
  plugin: NonNullable<ReturnType<typeof getPluginServer>>,
  actionType: string
): GamePluginActionPolicy {
  const policies = plugin.actionPolicies;
  if (policies && Object.hasOwn(policies, actionType)) return policies[actionType]!;
  return { role: 'host' };
}

async function authorizePluginAction(input: {
  serverId: string;
  sessionId: string;
  actorUserId: string;
  hostUserId: string | null;
  plugin: NonNullable<ReturnType<typeof getPluginServer>>;
  action: Record<string, unknown>;
  currentState: Record<string, unknown>;
  /** The game_sessions ROW status (lobby/running/paused/ended/cancelled). */
  sessionStatus: string;
  /** Who is in the activity's voice room; null when the plugin does not require voice. */
  voice: VoiceRoomSnapshot | null;
}): Promise<{ ok: true; action: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const actionType = String(input.action.type);
  const policy = actionPolicyFor(input.plugin, actionType);

  // LF-014: Reject actions on ended sessions.
  // beta-review: read the ROW status. The old check read
  // `currentState.status`, a field no plugin state has, so actions on an
  // ended session were accepted and broadcast.
  if (isTerminalSessionStatus(input.sessionStatus)) {
    return { ok: false, response: activityError(409, 'session_ended', 'Activity has ended.') };
  }

  // LF-014: Phase-based validation — reject actions that don't match the
  // current game phase. The plugin's reducer is the primary authority, but
  // this host-side check provides defense-in-depth against stale clients.
  const phase = (input.currentState as { phase?: string })?.phase;
  const phaseError = validateActionPhase(input.plugin, actionType, phase);
  if (phaseError) {
    return { ok: false, response: activityError(409, phaseError.code, phaseError.message) };
  }

  if (policy.role === 'host' && input.hostUserId !== input.actorUserId) {
    const permissions = await getUserPermissions(getDb(), input.actorUserId, input.serverId);
    if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
      return { ok: false, response: activityError(403, 'not_host', 'Forbidden') };
    }
  }

  if (policy.role === 'player') {
    const players = await listPlayersForSession(getDb(), input.sessionId);
    if (!players.some((p) => p.userId === input.actorUserId)) {
      return { ok: false, response: activityError(403, 'not_player', 'Player is not in this activity') };
    }
  }

  // A game that is played over voice: its players are in the voice room.
  // Spectating (reading the state) needs no voice; host actions are never
  // voice-checked (a moderator runs the table from anywhere, and a host who
  // left the room hands over — lib/activity-host.ts). When LiveKit cannot
  // be asked, the check is skipped (fail open, logged).
  if (
    policy.role !== 'host' &&
    policy.allowOutsideVoice !== true &&
    input.voice?.available &&
    !isInVoice(input.voice, input.actorUserId)
  ) {
    return {
      ok: false,
      response: activityError(403, 'voice_required', 'Join the activity’s voice channel to play.'),
    };
  }

  const normalizedAction = { ...input.action };
  for (const field of policy.actorFields ?? []) {
    normalizedAction[field] = input.actorUserId;
  }
  return { ok: true, action: normalizedAction };
}

/**
 * LF-014: Validate that an action type is allowed in the current game phase.
 * Returns the refusal if invalid, null if OK.
 * This is a host-side safety net — the plugin reducer is the primary
 * authority but this prevents stale clients from submitting actions
 * that are nonsensical for the phase.
 *
 * A finished game (`phase === 'ended'`) of a plugin that declares
 * `restartActions` accepts only those ("play again"); every other action
 * is an action on an ended activity. Plugins that declare none keep
 * deciding for themselves after the end (Vampire Village's post-game chat).
 */
function validateActionPhase(
  plugin: NonNullable<ReturnType<typeof getPluginServer>>,
  actionType: string,
  phase: string | undefined
): { code: 'session_ended' | 'wrong_phase'; message: string } | null {
  if (!phase) return null; // Can't validate without phase info.

  if (phase === 'ended' && Array.isArray(plugin.restartActions)) {
    return plugin.restartActions.includes(actionType)
      ? null
      : { code: 'session_ended', message: 'Game has ended.' };
  }

  const pluginId = plugin.manifest.id;
  if (pluginId === 'hushle') {
    // Hushle phases: lobby, team_setup, playing, ended
    const playingActions = ['correct-guess', 'pass', 'penalty', 'next-card', 'end-turn', 'bust-forbidden'];
    if (phase === 'lobby' && [...playingActions, 'end-game'].includes(actionType)) {
      return { code: 'wrong_phase', message: 'Game has not started yet.' };
    }
  }

  if (pluginId === 'quiz') {
    // Quiz phases: lobby, playing, reveal, ended
    if (phase === 'lobby' && ['answer', 'next'].includes(actionType)) {
      return { code: 'wrong_phase', message: 'Quiz has not started yet.' };
    }
    if (phase === 'reveal' && actionType === 'answer') {
      return { code: 'wrong_phase', message: 'Answer period has ended for this question.' };
    }
  }

  return null;
}

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string }> }
): Promise<NextResponse> {
  const { id: serverId, sessionId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  // Per user and session (the address limit is only a backstop: one
  // household shares it). Keyed before any database work.
  const limited = rateLimitResponse(
    await distributedRateLimit(`activity-action:user:${session.uid}:${sessionId}`, ACTION_USER_LIMIT),
    'activity-action-user'
  );
  if (limited) return limited;

  // LF-002: set once the idempotency claim is taken; the outer catch
  // releases it so an unexpected exception doesn't poison the retry —
  // UNLESS the new state already committed (V5-007): a post-commit
  // failure must leave the claim held so the retry reconciles via
  // 409+GET instead of re-entering the reducer.
  let releaseClaim = async () => {};
  let committed = false;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const row = await getGameSessionById(getDb(), sessionId);
    if (!row) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    if (row.serverId !== serverId) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }

    // SEC-002: the session's channel may be private (role-gated) —
    // membership alone is not enough; owner/manage_channels bypass.
    const visibility = await authorizeSessionChannelVisibility(session.uid, serverId, row, server.ownerUserId);
    if (!visibility.ok) return visibility.response;

    const plugin = getPluginServer(row.pluginId);
    if (!plugin) {
      // A session exists for a plugin we no longer ship. We can't
      // dispatch — surface a clear error so the UI can offer to end.
      return NextResponse.json(
        { error: 'Plugin not registered', pluginId: row.pluginId, howToFix: 'End the activity' },
        { status: 409 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }
    // The `type` field is required and must be a string. Other keys
    // are forwarded to the plugin as-is — except `actionId`, which is
    // the LF-002 idempotency key and is consumed here, never forwarded.
    const parseResult = ActionSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid action body' },
        { status: 400 }
      );
    }

    // LF-002: extract the optional idempotency key BEFORE authorization
    // so the plugin reducer never sees it.
    const rawActionId = body.actionId;
    if (rawActionId !== undefined && !isValidActionId(rawActionId)) {
      return NextResponse.json(
        { error: 'actionId must be a UUID v4-style string' },
        { status: 400 }
      );
    }
    const actionId = rawActionId;
    const forwardedAction: Record<string, unknown> = { ...body };
    delete forwardedAction.actionId;

    // A game played over voice: who is in its voice room (LiveKit) decides
    // whether a player may act, and whether a host who left it hands
    // hosting over (lazily, here — lib/activity-host.ts).
    const voice = pluginRequiresVoice(plugin) ? await getVoiceRoomSnapshot(serverId, row.channelId) : null;
    let hostUserId: string | null = row.createdBy ?? null;
    if (voice && !isTerminalSessionStatus(row.status)) {
      const host = await resolveActivityHost({
        db: getDb(),
        row,
        plugin,
        voice,
        ownerUserId: server.ownerUserId ?? null,
      });
      if (host) hostUserId = host.view.hostUserId;
    }

    const actionAuth = await authorizePluginAction({
      serverId,
      sessionId,
      actorUserId: session.uid,
      hostUserId,
      plugin,
      action: forwardedAction,
      currentState: row.state as Record<string, unknown>,
      sessionStatus: row.status,
      voice,
    });
    if (!actionAuth.ok) return actionAuth.response;

    // 31st-audit: plugin-specific action fields are NOT covered by the
    // generic { type } schema — they arrive as raw JSON from any client.
    // A plugin-declared validateAction rejects malformed payloads with a
    // clean 400 BEFORE dispatch (and before the idempotency claim, so
    // junk cannot poison an honest client's actionId).
    // beta-review: validate the NORMALIZED action — actor fields
    // (playerId/hostId/...) are injected from the session above, so a
    // validator requiring them must see the server-set values, not the
    // raw client body (which legitimately omits them).
    // Awaited: a marketplace plugin validates in the plugin worker (an RPC
    // that returns a Promise); an official plugin's plain return value is
    // unchanged by `await`. A worker failure throws → 500 (fail closed).
    if (plugin.validateAction) {
      const validationError = await plugin.validateAction(actionAuth.action);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
    }

    // LF-002: exactly-once dispatch per (sessionId, actionId). Claimed
    // only AFTER auth — unauthorized junk must not poison the key — and
    // RELEASED on every failure path below so an honest retry works.
    if (actionId) {
      // V4-001: an EXCEPTION from the claim store is an availability
      // problem, NOT a duplicate — fail CLOSED with a retryable 503.
      // V5-007: DuplicateActionError (the claim was taken) is the ONLY
      // duplicate signal; the claim handle carries an ownership token so
      // release is a compare-and-delete.
      let claim: ActionClaim;
      try {
        claim = await claimActionId(sessionId, actionId);
      } catch (err) {
        if (err instanceof DuplicateActionError) {
          return NextResponse.json(
            { error: 'Duplicate action — already processed.', duplicate: true },
            { status: 409 }
          );
        }
        console.error('[activity-action] idempotency store unavailable:', (err as Error).message);
        return NextResponse.json(
          { error: 'Action service temporarily unavailable — please retry.', retryable: true },
          { status: 503 }
        );
      }
      releaseClaim = async () => {
        await releaseActionId(claim);
      };
    }

    let prepared: Awaited<ReturnType<typeof preparePluginAction>>;
    try {
      prepared = await preparePluginAction(getDb(), {
        pluginId: row.pluginId,
        serverId,
        action: actionAuth.action,
      });
    } catch {
      await releaseClaim();
      return NextResponse.json({ error: 'Failed to prepare action' }, { status: 500 });
    }
    if (!prepared.ok) {
      await releaseClaim();
      return NextResponse.json({ error: prepared.error }, { status: prepared.status });
    }

    // The roster is the activity's list of players, shown to every viewer.
    // Joining it is opt-in per action (`joinsRoster`): a join, a public dice
    // roll — never an anonymous vote, which it would name. The actor is
    // offered to the reducer as a player while the action runs, and only
    // written to the roster once the action has changed state and saved.
    const joinsRoster = actionPolicyFor(plugin, String(prepared.action.type)).joinsRoster === true;
    let joiningPlayer = false;
    if (joinsRoster) {
      try {
        const roster = await listPlayersForSession(getDb(), sessionId);
        joiningPlayer = !roster.some((p) => p.userId === session.uid);
      } catch (err) {
        console.warn('[activity-action] roster read failed:', (err as Error).message);
      }
    }

    const ctx2 = await buildHttpPluginContext({
      db: getDb(),
      sessionId,
      actorUserId: session.uid,
      serverId,
      pluginId: row.pluginId,
      pendingPlayerId: joiningPlayer ? session.uid : undefined,
      voiceParticipantIds: voice?.available ? voice.participants.map((p) => p.userId) : undefined,
    });
    // ADR-007: the sandbox ctx also carries the session, its host, the
    // caller's language and ONE clock for the call and its CAS retries.
    const sandboxed = isWorkerBackedPlugin(plugin);
    if (sandboxed) {
      attachSandboxScope(ctx2, {
        sessionId,
        hostUserId,
        locale: sandboxLocaleFor(req),
        now: Date.now(),
      });
    }
    // State versioning: upgrade the persisted row to the plugin's
    // current shape before running the reducer. The reducer only
    // accepts the current shape, so without this step a session
    // written by an older build would crash on the first action.
    // Awaited: a marketplace plugin's migrateState is an RPC to the
    // plugin-worker and returns a Promise. Used unawaited, the reducer got
    // the Promise (serialized as `{}`) and the state was lost on every
    // action. Awaiting an official plugin's plain return value is a no-op.
    const migratedState = plugin.migrateState
      ? ((await plugin.migrateState(row.state)) as Record<string, unknown>)
      : row.state;

    // Read → reduce → write, serialized per session. Concurrent actions used
    // to race on an optimistic CAS with 3 attempts: of 8 players rolling dice
    // at once, only 3–4 got through and the rest saw a 409. Under the
    // session's write lock (a transaction-scoped Postgres advisory lock, see
    // withGameSessionWriteLock) the reducer runs on the row as it stands, so
    // its write cannot lose a race with another action — every web process
    // takes the same lock. The CAS stays: it refuses a terminal row (a
    // concurrent END, which does not take the lock) and any writer that
    // skips the lock.
    const expectedRevision = (row as { revision?: number }).revision ?? 0;
    type CommittedRow = { id: string; state: Record<string, unknown>; status: string; revision: number };
    type LockedOutcome =
      | { kind: 'committed'; state: Record<string, unknown>; changed: boolean; row: CommittedRow }
      | { kind: 'gone' }
      | { kind: 'ended' }
      | { kind: 'conflict'; revision: number };
    let outcome: LockedOutcome;
    try {
      outcome = await withGameSessionWriteLock(getDb(), sessionId, async (tx, fresh): Promise<LockedOutcome> => {
        if (!fresh) return { kind: 'gone' };
        // beta-review: a terminal session is read-only — an END that landed
        // while this action waited wins.
        if (isTerminalSessionStatus(fresh.status)) return { kind: 'ended' };
        const freshRevision = (fresh as { revision?: number }).revision ?? 0;
        // Nobody wrote since the read above: reuse its migration (a worker
        // RPC for a marketplace plugin). Otherwise migrate the fresh state.
        const currentState =
          freshRevision === expectedRevision
            ? migratedState
            : plugin.migrateState
              ? ((await plugin.migrateState(fresh.state)) as Record<string, unknown>)
              : fresh.state;
        const nextState = (await callHandleAction(plugin, ctx2, currentState, prepared.action)) as Record<string, unknown>;
        const cas = (await setGameSessionStateCAS(tx, sessionId, freshRevision, nextState)) as {
          ok: boolean;
          row: CommittedRow | null;
        };
        if (cas.ok && cas.row) {
          // Reducers return the SAME object for a refused or no-op action.
          return { kind: 'committed', state: nextState, changed: nextState !== currentState, row: cas.row };
        }
        if (!cas.row) return { kind: 'gone' };
        if (isTerminalSessionStatus(cas.row.status)) return { kind: 'ended' };
        return { kind: 'conflict', revision: cas.row.revision };
      });
    } catch (err) {
      // The lock was not granted in time (a slow reducer ahead in the
      // queue): retryable, like a conflict.
      if (!(err instanceof GameSessionBusyError)) throw err;
      await releaseClaim();
      return NextResponse.json(
        { error: 'Conflict: too many concurrent actions. Please retry.', retryable: true },
        { status: 409 }
      );
    }

    if (outcome.kind === 'gone') {
      await releaseClaim();
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    if (outcome.kind === 'ended') {
      await releaseClaim();
      return activityError(409, 'session_ended', 'Activity has ended.');
    }
    if (outcome.kind === 'conflict') {
      // Retryable conflict — release so the client may retry the same id.
      await releaseClaim();
      return NextResponse.json(
        { error: 'Conflict: too many concurrent actions. Please retry.', revision: outcome.revision, retryable: true },
        { status: 409 }
      );
    }
    // The transaction committed: from here on a failure must keep the claim
    // (V5-007) so a retry reconciles instead of re-running the reducer.
    committed = true;
    const committedState = outcome.state;
    const stateChanged = outcome.changed;

    // Push the committed state to any open SSE subscriptions on this session.
    // Fire-and-forget — a Redis blip must not fail the action.
    // SEC-001: NO state on the bus — subscribers load + project per
    // viewer. The summary carries only public counts (never secret
    // fields), so even a compromised fanout cannot leak cards/answers.
    // Official plugins only: a marketplace plugin's `deck` could be secret,
    // and only its own projectState decides what viewers learn.
    const deckSize = !sandboxed && Array.isArray((committedState as { deck?: unknown }).deck)
      ? ((committedState as { deck?: unknown[] }).deck as unknown[]).length
      : undefined;
    let rosterChanged = false;
    if (joiningPlayer && stateChanged) {
      try {
        await addPlayerToSession(getDb(), sessionId, session.uid);
        rosterChanged = true;
      } catch (err) {
        console.warn('[activity-action] roster update failed:', (err as Error).message);
      }
    }

    // `rosterChanged` tells subscribers to re-read the player list (names
    // included) — the bus itself never carries identities.
    const publicSummary: Record<string, unknown> = {};
    if (deckSize !== undefined) publicSummary.deckSize = deckSize;
    if (rosterChanged) publicSummary.rosterChanged = true;
    publishActivityStateChange({
      serverId,
      sessionId,
      status: outcome.row.status,
      revision: outcome.row.revision,
      publicSummary: Object.keys(publicSummary).length > 0 ? publicSummary : undefined,
    });
    // security-review PLUG-001: audit only actions that changed state AND
    // whose policy asks for it — host actions by default, never gameplay.
    // VIEW_AUDIT_LOG holders read every row, so "u1 sent pack-chat" named a
    // vampire, a night-* row a night role, and `vote` rows lined up with
    // the poll counts named anonymous voters; refused actions were logged
    // too. Same policy lookup (and host default) as authorizePluginAction.
    const auditPolicy = actionPolicyFor(plugin, String(parseResult.data.type));
    if (stateChanged && shouldAuditAction(auditPolicy)) {
      void logAction(getDb(), {
        serverId,
        actorUserId: session.uid,
        action: 'activity.action',
        targetType: 'session',
        targetId: sessionId,
        metadata: { pluginId: row.pluginId, actionType: parseResult.data.type },
      }).catch((err) => console.error('[audit] activity.action failed:', (err as Error).message));
    }

    // LF-001: EVERYONE gets the projection — including the host. Anti-cheat.
    // ADR-007: a marketplace plugin projects in the plugin worker. If that
    // fails, the action has still been applied: say so, never send the
    // unprojected state.
    let viewerState: unknown;
    try {
      viewerState = await projectStateForViewer({
        plugin,
        pluginId: row.pluginId,
        state: committedState,
        viewerUserId: session.uid,
        ctx: {
          sessionId,
          serverId,
          hostUserId,
        },
      });
    } catch (err) {
      console.error('[activity-action] projection failed after commit:', JSON.stringify((err as Error).message));
      return NextResponse.json(
        { error: 'The action was applied, but your view of the activity could not be loaded. Reload to see it.', applied: true },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { activity: { id: row.id, state: viewerState, status: row.status } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    // Unexpected failure — release the idempotency claim so an honest
    // client retry with the same actionId isn't rejected as a duplicate.
    // After a COMMITTED write the claim stays held (see above).
    if (!committed) await releaseClaim();
    return NextResponse.json(
      { error: 'Failed to perform action' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  // Per address: a backstop only (see ACTION_USER_LIMIT for the real limit).
  rateLimit: { identifier: 'activity-action', config: ACTION_ADDRESS_LIMIT },
});
