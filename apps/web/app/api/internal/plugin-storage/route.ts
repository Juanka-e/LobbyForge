import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  clearPluginData,
  deletePluginData,
  getPluginData,
  listPluginData,
  setPluginData,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * INTERNAL endpoint — plugin-storage capability for the isolated
 * plugin-worker (LF-SEC-010). The worker holds no database credentials;
 * ctx.storage.* calls execute HERE on the plugin's behalf, hard-scoped
 * to the (serverId, pluginId) the envelope carries.
 *
 * Never exposed publicly: nginx returns 404 for /api/internal/* and the
 * service is reachable only on the compose-internal network. The
 * request must carry the shared storage token (constant-time compare).
 */

const KeySchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);

const StorageOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), serverId: z.string().uuid(), pluginId: z.string().min(2).max(128), key: KeySchema }),
  z.object({ op: z.literal('set'), serverId: z.string().uuid(), pluginId: z.string().min(2).max(128), key: KeySchema, value: z.unknown() }),
  z.object({ op: z.literal('delete'), serverId: z.string().uuid(), pluginId: z.string().min(2).max(128), key: KeySchema }),
  z.object({ op: z.literal('list'), serverId: z.string().uuid(), pluginId: z.string().min(2).max(128) }),
  z.object({ op: z.literal('clear'), serverId: z.string().uuid(), pluginId: z.string().min(2).max(128) }),
]);

function tokenOk(req: Request): boolean {
  const expected = process.env.LOBBYFORGE_PLUGIN_STORAGE_TOKEN;
  if (!expected || expected.length < 32) return false;
  const provided = req.headers.get('x-lf-plugin-storage-token') ?? '';
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

async function handlePost(req: Request): Promise<NextResponse> {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: z.infer<typeof StorageOpSchema>;
  try {
    body = StorageOpSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const db = getDb();
  try {
    switch (body.op) {
      case 'get': {
        const value = await getPluginData(db, body.serverId, body.pluginId, body.key);
        return NextResponse.json({ value: value ?? null });
      }
      case 'set':
        await setPluginData(db, body.serverId, body.pluginId, body.key, body.value);
        return NextResponse.json({ ok: true });
      case 'delete': {
        const deleted = await deletePluginData(db, body.serverId, body.pluginId, body.key);
        return NextResponse.json({ deleted });
      }
      case 'list': {
        const items = await listPluginData(db, body.serverId, body.pluginId);
        return NextResponse.json({ items });
      }
      case 'clear':
        await clearPluginData(db, body.serverId, body.pluginId);
        return NextResponse.json({ ok: true });
    }
  } catch {
    return NextResponse.json({ error: 'Storage operation failed' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 256 * 1024,
  rateLimit: { identifier: 'internal-plugin-storage', config: { windowMs: 60_000, maxRequests: 600 } },
  sessionRevocation: 'bypass',
  maintenanceMode: 'bypass',
});
