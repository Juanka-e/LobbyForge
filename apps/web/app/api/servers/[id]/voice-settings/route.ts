import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEffectiveServerVoiceSettings,
  updateServerVoiceSettings,
  type ServerVoiceSettingsRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import {
  CorePermission,
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
} from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NullableLimit = z.number().int().min(1).max(500).nullable();
const NullableMediaLimit = z.number().int().min(1).max(100).nullable();

const PatchSchema = z.object({
  defaultUserLimit: NullableLimit.optional(),
  requirePushToTalk: z.boolean().optional(),
  startMuted: z.boolean().optional(),
  allowCamera: z.boolean().optional(),
  allowScreenShare: z.boolean().optional(),
  maxCameraUsersPerRoom: NullableMediaLimit.optional(),
  maxScreenShareUsersPerRoom: NullableMediaLimit.optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

function toJson(settings: ServerVoiceSettingsRow): Record<string, unknown> {
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

async function requireReadable(req: Request, serverId: string) {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult;
  const member = await requireServerMember(sessionResult.session.uid, serverId);
  if (!member.ok) return member;
  return { ok: true as const, uid: sessionResult.session.uid };
}

async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const access = await requireReadable(req, serverId);
  if (!access.ok) return access.response;

  try {
    const settings = await getEffectiveServerVoiceSettings(getDb(), serverId);
    return NextResponse.json({ settings: toJson(settings) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to load voice settings' }, { status: 500 });
  }
}

async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const access = await requireReadable(req, serverId);
  if (!access.ok) return access.response;

  const permission = await requireServerPermission(access.uid, serverId, CorePermission.MANAGE_SERVER);
  if (!permission.ok) return permission.response;

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const settings = await updateServerVoiceSettings(getDb(), serverId, body);
    return NextResponse.json({ settings: toJson(settings) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to update voice settings' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'voice-settings-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'voice-settings-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
