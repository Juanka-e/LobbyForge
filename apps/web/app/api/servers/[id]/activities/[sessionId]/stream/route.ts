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
  | { ok: true; uid: string }
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
  return { ok: true, uid: session.uid };
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
    const plugin = getPluginServer(row.pluginId);
    const initialState = plugin?.migrateState ? plugin.migrateState(row.state) : row.state;

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sse('snapshot', {
              id: row.id,
              pluginId: row.pluginId,
              status: row.status,
              state: initialState,
              publicSummary: row.publicSummary,
              createdBy: row.createdBy,
              at: new Date().toISOString(),
            })
          )
        );
        controller.enqueue(encoder.encode(sse('hello', { ok: true })));

        const subscription = subscribeActivityStateChange(
          serverId,
          sessionId,
          (msg) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(
                sse('state', { status: msg.status, state: msg.state, at: msg.at })
              )
            );
          },
          (err) => {
            if (closed) return;
            console.error('[activity-stream] subscription error:', (err as Error).message);
            controller.enqueue(
              encoder.encode(sse('error', { message: 'stream error' }))
            );
          }
        );

        const keepAlive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            closed = true;
          }
        }, 30_000);

        const abort = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          subscription.close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        req.signal.addEventListener('abort', abort);
      },
      cancel() {
        closed = true;
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
