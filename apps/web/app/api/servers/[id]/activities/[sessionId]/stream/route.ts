/**
 * SSE stream for a single activity session.
 *
 * Browser opens an `EventSource` to this URL; the server pushes a
 * `state` event every time the action route publishes a state
 * change. The route is membership-gated (server owner / member
 * only) and rate-limited per caller — a runaway client shouldn't
 * be able to pin a worker.
 *
 * The route also sends a `snapshot` event on connect (so the
 * browser doesn't wait for the next action to render) and a
 * `hello` event so the client can measure connect latency. A 30s
 * keep-alive ping prevents intermediary proxies from closing the
 * stream.
 *
 * Implementation note: we don't use `withApiSecurity` here because
 * the response is a streamed `Response` (not a `NextResponse`).
 * Instead we manually call the same security + rate-limit helpers
 * the wrapper uses — same effect, but compatible with the SSE
 * payload.
 */
import {
  getGameSessionById,
  getServerById,
  isServerMember,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import {
  distributedRateLimit,
  methodAllowlist,
  originGuard,
  rateLimitKey,
  rateLimitResponse,
} from '@/lib/security-headers';
import { getPluginServer } from '@/lib/plugin-server-registry';
import { projectActivityState } from '@/lib/activity-projection';
import { isSessionRevoked } from '@/lib/session-tracker';
import { authorizeSessionChannelVisibility } from '@/lib/permissions';
import { subscribeActivityStateChange } from '@/lib/activity-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function applySecurityHeaders(response: Response): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string; gid: string }
  | { ok: false; response: Response }
> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return { ok: false, response: jsonError(401, { error: 'Authentication required' }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: jsonError(503, {
        error: 'Guest user has no materialized user record',
        howToFix: 'Re-issue POST /api/auth/guest',
      }),
    };
  }
  return { ok: true, uid: session.uid, gid: session.gid };
}

function sse(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function handleStream(
  req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string }> }
): Promise<Response> {
  // Method allowlist (only GET — EventSource doesn't issue other verbs).
  const methodCheck = methodAllowlist(req, ['GET']);
  if (methodCheck) return applySecurityHeaders(methodCheck);
  // Origin guard for non-GET is a no-op here, but keep parity with the
  // wrapper so a future POST/DELETE doesn't silently bypass it.
  const originCheck = originGuard(req);
  if (originCheck) return applySecurityHeaders(originCheck);
  // Rate limit — generous enough for one tab + reconnect storms.
  const rate = await distributedRateLimit(rateLimitKey(req, 'activity-stream'), {
    windowMs: 60_000,
    maxRequests: 30,
  });
  const blocked = rateLimitResponse(rate);
  if (blocked) return applySecurityHeaders(blocked);

  const { id: serverId, sessionId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return applySecurityHeaders(session.response);

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) return applySecurityHeaders(jsonError(404, { error: 'Server not found' }));
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return applySecurityHeaders(jsonError(403, { error: 'Forbidden' }));
      }
    }
    const row = await getGameSessionById(getDb(), sessionId);
    if (!row) return applySecurityHeaders(jsonError(404, { error: 'Activity not found' }));
    if (row.serverId !== serverId) {
      return applySecurityHeaders(jsonError(404, { error: 'Activity not found' }));
    }

    // SEC-002: the session's channel may be private (role-gated) —
    // membership alone is not enough; owner/manage_channels bypass.
    const visibility = await authorizeSessionChannelVisibility(
      session.uid,
      serverId,
      row,
      server.ownerUserId
    );
    if (!visibility.ok) return applySecurityHeaders(visibility.response);

    const plugin = getPluginServer(row.pluginId);
    const initialState = plugin?.migrateState ? plugin.migrateState(row.state) : row.state;

    // LF-001: EVERYONE gets the projection — including the host. A host who
    // isn't the current explainer must not see the secret card (anti-cheat).
    const projectedInitial = projectActivityState(initialState, row.pluginId, session.uid);

    const encoder = new TextEncoder();
    let closed = false;
    // RT-001: shared cleanup ref — set by start(), callable from cancel().
    let abortRef: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sse('snapshot', {
              id: row.id,
              pluginId: row.pluginId,
              status: row.status,
              state: projectedInitial,
              publicSummary: row.publicSummary,
              createdBy: row.createdBy,
              at: new Date().toISOString(),
            })
          )
        );
        controller.enqueue(encoder.encode(sse('hello', { ok: true })));

        let subscription: { close: () => void } | null = null;
        void subscribeActivityStateChange(
          serverId,
          sessionId,
          (msg) => {
            if (closed) return;
            // SEC-001: the bus no longer carries state — LOAD the session
            // and project it for THIS viewer (same as the ws-gateway).
            void (async () => {
              try {
                const fresh = await getGameSessionById(getDb(), sessionId);
                if (!fresh) {
                  controller.enqueue(encoder.encode(sse('state', { status: msg.status, state: null, at: msg.at })));
                  return;
                }
                const projectedMsg = projectActivityState(fresh.state, row.pluginId, session.uid);
                controller.enqueue(
                  encoder.encode(
                    sse('state', { status: msg.status, state: projectedMsg, at: msg.at, revision: msg.revision })
                  )
                );
              } catch {
                // Fail closed — never send unprojected state.
              }
            })();
          },
          (err) => {
            if (closed) return;
            console.error('[activity-stream] subscription error:', (err as Error).message);
            controller.enqueue(
              encoder.encode(sse('error', { message: 'stream error' }))
            );
          }
        ).then((sub) => {
          if (closed) sub.close();
          else subscription = sub;
        });

        const keepAlive = setInterval(() => {
            if (closed) return;
            // SEC-003: a revoked session must not keep an OPEN stream.
            void isSessionRevoked(session.uid, session.gid)
              .then((revoked) => {
                if (revoked && !closed) abort();
              })
              .catch(() => { /* Redis down — REST stays the strict gate */ });
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            // RT-001: a failed enqueue means the stream is gone — run
            // the shared cleanup (the old closed=true alone leaked the
            // interval + Redis subscription because abort() early-returns
            // on closed).
            abort();
          }
        }, 30_000);

        // RT-001: ONE idempotent cleanup for abort, cancel, error and
        // revocation — the old cancel() only set closed=true and leaked
        // the interval + Redis subscription.
        const abort = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          subscription?.close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        req.signal.addEventListener('abort', abort);
        abortRef = abort;
        return abort;
      },
      cancel() {
        abortRef?.();
      },
    });

    const response = new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
    return applySecurityHeaders(response);
  } catch {
    return applySecurityHeaders(
      jsonError(500, { error: 'Failed to open stream' })
    );
  }
}

export const GET = handleStream;
