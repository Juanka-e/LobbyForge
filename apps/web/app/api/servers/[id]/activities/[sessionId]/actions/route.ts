import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getGameSessionById,
  getServerById,
  getUserPermissions,
  isServerMember,
  listPlayersForSession,
  logAction,
  setGameSessionStateCAS,
} from '@lobbyforge/db';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getPluginServer } from '@/lib/plugin-server-registry';
import { projectActivityState } from '@/lib/activity-projection';
import { buildHttpPluginContext, callHandleAction } from '@/lib/plugin-context';
import { withApiSecurity } from '@/lib/security-headers';
import { publishActivityStateChange } from '@/lib/activity-bus';
import { preparePluginAction } from '@/lib/prepare-plugin-action';
import {
  ActionClaim,
  DuplicateActionError,
  claimActionId,
  isValidActionId,
  releaseActionId,
} from '@/lib/action-idempotency';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ActionSchema = z.object({
  type: z.string().min(1).max(64),
  // Action-specific fields are accepted but the host does not
  // validate them — the plugin's handleAction decides what's
  // meaningful for its own action union.
});

async function authorizePluginAction(input: {
  serverId: string;
  sessionId: string;
  actorUserId: string;
  hostUserId: string | null;
  plugin: NonNullable<ReturnType<typeof getPluginServer>>;
  action: Record<string, unknown>;
  currentState: Record<string, unknown>;
}): Promise<{ ok: true; action: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const actionType = String(input.action.type);
  const policy = input.plugin.actionPolicies?.[actionType] ?? { role: 'host' as const };

  // LF-014: Reject actions on ended sessions.
  const status = (input.currentState as { status?: string })?.status;
  if (status === 'ended' || status === 'cancelled') {
    return { ok: false, response: NextResponse.json({ error: 'Activity has ended.' }, { status: 409 }) };
  }

  // LF-014: Phase-based validation — reject actions that don't match the
  // current game phase. The plugin's reducer is the primary authority, but
  // this host-side check provides defense-in-depth against stale clients.
  const phase = (input.currentState as { phase?: string })?.phase;
  const phaseError = validateActionPhase(input.plugin.manifest.id, actionType, phase);
  if (phaseError) {
    return { ok: false, response: NextResponse.json({ error: phaseError }, { status: 409 }) };
  }

  if (policy.role === 'host' && input.hostUserId !== input.actorUserId) {
    const permissions = await getUserPermissions(getDb(), input.actorUserId, input.serverId);
    if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }

  if (policy.role === 'player') {
    const players = await listPlayersForSession(getDb(), input.sessionId);
    if (!players.some((p) => p.userId === input.actorUserId)) {
      return { ok: false, response: NextResponse.json({ error: 'Player is not in this activity' }, { status: 403 }) };
    }
  }

  const normalizedAction = { ...input.action };
  for (const field of policy.actorFields ?? []) {
    normalizedAction[field] = input.actorUserId;
  }
  return { ok: true, action: normalizedAction };
}

/**
 * LF-014: Validate that an action type is allowed in the current game phase.
 * Returns an error message if invalid, null if OK.
 * This is a host-side safety net — the plugin reducer is the primary
 * authority but this prevents stale clients from submitting actions
 * that are nonsensical for the phase.
 */
function validateActionPhase(pluginId: string, actionType: string, phase: string | undefined): string | null {
  if (!phase) return null; // Can't validate without phase info.

  if (pluginId === 'hushle') {
    // Hushle phases: lobby, team_setup, playing, ended
    const playingActions = ['correct-guess', 'pass', 'penalty', 'next-card', 'end-turn', 'bust-forbidden'];
    if (phase === 'lobby' && [...playingActions, 'end-game'].includes(actionType)) {
      return 'Game has not started yet.';
    }
    if (phase === 'ended' && actionType !== 'end-game') {
      return 'Game has ended.';
    }
  }

  if (pluginId === 'quiz') {
    // Quiz phases: lobby, playing, reveal, ended
    if (phase === 'lobby' && ['answer', 'next'].includes(actionType)) {
      return 'Quiz has not started yet.';
    }
    if (phase === 'reveal' && actionType === 'answer') {
      return 'Answer period has ended for this question.';
    }
    if (phase === 'ended') {
      return 'Quiz has ended.';
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

    const actionAuth = await authorizePluginAction({
      serverId,
      sessionId,
      actorUserId: session.uid,
      hostUserId: row.createdBy,
      plugin,
      action: forwardedAction,
      currentState: row.state as Record<string, unknown>,
    });
    if (!actionAuth.ok) return actionAuth.response;

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

    const ctx2 = await buildHttpPluginContext({
      db: getDb(),
      sessionId,
      actorUserId: session.uid,
      serverId,
      pluginId: row.pluginId,
    });
    // State versioning: upgrade the persisted row to the plugin's
    // current shape before running the reducer. The reducer only
    // accepts the current shape, so without this step a session
    // written by an older build would crash on the first action.
    const migratedState = plugin.migrateState
      ? (plugin.migrateState(row.state) as Record<string, unknown>)
      : row.state;

    // Compare-and-swap with optimistic concurrency. On each retry the
    // reducer is RE-RUN against the fresh state — computing nextState once
    // outside the loop would just move the lost-update one revision later.
    const expectedRevision = (row as { revision?: number }).revision ?? 0;
    const MAX_CAS_RETRIES = 3;
    let casResult: { ok: boolean; row: { id: string; state: Record<string, unknown>; status: string; revision: number } | null } = { ok: false, row: null };
    let currentState = migratedState;
    let currentRev = expectedRevision;
    let committedState: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      // Run the reducer against the CURRENT state on every attempt.
      const attemptState = await callHandleAction(plugin, ctx2, currentState, prepared.action) as Record<string, unknown>;
      casResult = await setGameSessionStateCAS(getDb(), sessionId, currentRev, attemptState) as typeof casResult;
      if (casResult.ok) {
        committedState = attemptState;
        committed = true;
        break;
      }
      // Concurrent modification — re-read, re-migrate; the reducer runs
      // again at the top of the next iteration.
      if (!casResult.row) {
        await releaseClaim();
        return NextResponse.json({ error: 'Session not found during CAS retry.' }, { status: 404 });
      }
      currentRev = casResult.row.revision;
      currentState = plugin.migrateState
        ? (plugin.migrateState(casResult.row.state) as Record<string, unknown>)
        : casResult.row.state;
    }

    if (!casResult.ok || !committedState) {
      // Retryable conflict — release so the client may retry the same id.
      await releaseClaim();
      return NextResponse.json(
        { error: 'Conflict: too many concurrent actions. Please retry.', revision: currentRev },
        { status: 409 }
      );
    }

    // Push the committed state to any open SSE subscriptions on this session.
    // Fire-and-forget — a Redis blip must not fail the action.
    publishActivityStateChange({
      serverId,
      sessionId,
      status: (casResult.row as { status?: string })?.status ?? row.status,
      state: committedState,
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'activity.action',
      targetType: 'session',
      targetId: sessionId,
      metadata: { pluginId: row.pluginId, actionType: parseResult.data.type },
    }).catch((err) => console.error('[audit] activity.action failed:', (err as Error).message));

    // LF-001: EVERYONE gets the projection — including the host. Anti-cheat.
    const viewerState = projectActivityState(committedState, row.pluginId, session.uid);
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
  rateLimit: { identifier: 'activity-action', config: { windowMs: 60_000, maxRequests: 30 } },
});
