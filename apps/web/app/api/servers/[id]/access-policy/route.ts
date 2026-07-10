import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEffectiveServerAccessPolicy,
  logAction,
  upsertServerAccessPolicy,
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

const AccessPolicySchema = z.object({
  joinPolicy: z.enum(['invite_only', 'public_with_approval', 'public_self_register', 'guest_allowed']),
  externalIdentity: z.enum(['off', 'allow_lobbyforge', 'require_lobbyforge_for_registry']),
  localAccount: z.enum(['allow_local_email_password', 'existing_local_users_only', 'guest_only_invites']),
  accountLinking: z.enum(['allow_link', 'auto_create_from_lobbyforge', 'require_admin_approval_first_join']),
  requireApprovalForFirstJoin: z.boolean(),
}).strict();

function toJson(policy: Awaited<ReturnType<typeof getEffectiveServerAccessPolicy>>) {
  return {
    id: policy.id,
    serverId: policy.serverId,
    joinPolicy: policy.joinPolicy,
    externalIdentity: policy.externalIdentity,
    localAccount: policy.localAccount,
    accountLinking: policy.accountLinking,
    requireApprovalForFirstJoin: policy.requireApprovalForFirstJoin,
    updatedAt: policy.updatedAt ? policy.updatedAt.toISOString() : null,
  };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;

  const policy = await getEffectiveServerAccessPolicy(getDb(), serverId);
  return NextResponse.json(
    { accessPolicy: toJson(policy) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function handlePatch(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;
  const permission = await requireServerPermission(session.session.uid, serverId, CorePermission.MANAGE_SERVER);
  if (!permission.ok) return permission.response;

  let body: z.infer<typeof AccessPolicySchema>;
  try {
    body = AccessPolicySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const policy = await upsertServerAccessPolicy(getDb(), { serverId, ...body });
  void logAction(getDb(), {
    serverId,
    actorUserId: session.session.uid,
    action: 'server.access_policy.update',
    targetType: 'server',
    targetId: serverId,
    metadata: {
      joinPolicy: policy.joinPolicy,
      externalIdentity: policy.externalIdentity,
      localAccount: policy.localAccount,
      accountLinking: policy.accountLinking,
      requireApprovalForFirstJoin: policy.requireApprovalForFirstJoin,
    },
  }).catch((err) => console.error('[audit] server.access_policy.update failed:', (err as Error).message));

  return NextResponse.json(
    { accessPolicy: toJson(policy) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-access-policy-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'server-access-policy-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
