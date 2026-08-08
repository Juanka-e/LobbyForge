import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DisplayNameSchema } from '@lobbyforge/core';
import {
  createLocalAccount,
  getEffectiveInstanceAccessSettings,
  getInviteMetadata,
  getInstanceBootstrapStatus,
  getServerAccessPolicy,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { getSessionSecret } from '@/lib/api-auth';
import { normalizeInviteCode } from '@/lib/invite-code';
import { hashPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: DisplayNameSchema,
  password: z.string().min(12, 'Password must be at least 12 characters.').max(128),
  inviteCode: z.string().trim().max(16).optional(),
}).strict();

async function handlePost(req: Request): Promise<NextResponse> {
  if (isOfficialDeployment()) {
    return NextResponse.json({ error: 'Local registration is unavailable here.' }, { status: 404 });
  }

  const parsed = RegisterSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid registration payload.' },
      { status: 400 }
    );
  }

  const settings = await getEffectiveInstanceAccessSettings(getDb());
  if (settings.registrationMode === 'closed') {
    return NextResponse.json({ error: 'New registrations are closed.' }, { status: 403 });
  }

  const rawInviteCode = parsed.data.inviteCode || '';
  const inviteCode = rawInviteCode ? normalizeInviteCode(rawInviteCode) : null;
  if (rawInviteCode && !inviteCode) {
    return NextResponse.json({ error: 'A valid invite code is required.' }, { status: 400 });
  }
  if (settings.registrationMode === 'invite_only' && !inviteCode) {
    return NextResponse.json({ error: 'A valid invite code is required.' }, { status: 400 });
  }

  const setup = await getInstanceBootstrapStatus(getDb());
  if (!setup.bootstrapComplete || (!inviteCode && !setup.firstServerId)) {
    return NextResponse.json({ error: 'Community registration is unavailable.' }, { status: 503 });
  }

  const invite = inviteCode ? await getInviteMetadata(getDb(), inviteCode) : null;
  if (inviteCode && (!invite || invite.isExpired || invite.isExhausted)) {
    return NextResponse.json({ error: 'Invite is unavailable.' }, { status: 403 });
  }
  const targetServerId = invite?.serverId ?? setup.firstServerId;
  if (!targetServerId) {
    return NextResponse.json({ error: 'Community registration is unavailable.' }, { status: 503 });
  }
  const serverPolicy = await getServerAccessPolicy(getDb(), targetServerId);
  if (serverPolicy) {
    if (serverPolicy.localAccount !== 'allow_local_email_password') {
      return NextResponse.json({ error: 'New local accounts are disabled for this community.' }, { status: 403 });
    }
    if (
      serverPolicy.requireApprovalForFirstJoin ||
      serverPolicy.joinPolicy === 'public_with_approval' ||
      serverPolicy.accountLinking === 'require_admin_approval_first_join'
    ) {
      return NextResponse.json({ error: 'Administrator approval is required before registration.' }, { status: 403 });
    }
    if (!inviteCode && serverPolicy.joinPolicy !== 'public_self_register') {
      return NextResponse.json({ error: 'A valid invite code is required.' }, { status: 403 });
    }
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const result = await createLocalAccount(getDb(), {
    email: parsed.data.email,
    displayName: parsed.data.displayName,
    passwordHash,
    ...(inviteCode ? { inviteCode } : { serverId: setup.firstServerId! }),
  });
  if (!result.ok) {
    if (result.error === 'email_exists') {
      return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 });
    }
    if (result.error === 'banned') {
      return NextResponse.json({ error: 'Registration is not permitted for this community.' }, { status: 403 });
    }
    if (result.error === 'not_found' || result.error === 'expired' || result.error === 'exhausted') {
      return NextResponse.json({ error: 'Invite is unavailable.' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Account could not be created.' }, { status: 409 });
  }

  const seed = createGuestIdentity();
  const session = buildGuestSessionCookie(
    { gid: seed.gid, uid: result.user.id, name: result.user.displayName },
    getSessionSecret(),
    { secure: process.env.NODE_ENV === 'production' }
  );
  void recordSession(result.user.id, seed.gid, req).catch((error) => {
    console.error('[auth/register] session tracking failed', (error as Error).message);
  });
  return NextResponse.json(
    { user: result.user, serverId: result.serverId },
    { status: 201, headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  maxBodyBytes: 4 * 1024,
  rateLimit: { identifier: 'auth-local-register', config: { windowMs: 15 * 60_000, maxRequests: 5 } },
});
