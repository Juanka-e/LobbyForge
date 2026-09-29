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
import { createOfficialAccount } from '@/lib/official-account';
import { hashPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';
import { notifyMemberJoined } from '@/lib/bots/welcome';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: DisplayNameSchema,
  password: z.string().min(12, 'Password must be at least 12 characters.').max(128),
  inviteCode: z.string().trim().max(16).optional(),
}).strict();

type RegisterInput = z.infer<typeof RegisterSchema>;

async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = RegisterSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid registration payload.' },
      { status: 400 }
    );
  }

  if (isOfficialDeployment()) return registerOfficialAccount(req, parsed.data);

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

  // Bots milestone: registering joins a server — the Welcome Bot greets
  // the new member (never throws, so it cannot fail the registration).
  await notifyMemberJoined({ serverId: result.serverId, userId: result.user.id });
  return signedInResponse(req, result.user, { user: result.user, serverId: result.serverId });
}

/**
 * The official hub: an account is created without joining a community —
 * there is none to join at sign-up (see `lib/official-account.ts`). The
 * instance registration policy above does not apply: it governs a
 * self-hosted community's membership, and the hub has no such policy
 * (Google sign-up on the hub is open for the same reason).
 */
async function registerOfficialAccount(req: Request, data: RegisterInput): Promise<NextResponse> {
  if (data.inviteCode) {
    return NextResponse.json({ error: 'Invite codes are redeemed after you sign in.' }, { status: 400 });
  }
  const passwordHash = await hashPassword(data.password);
  const result = await createOfficialAccount(getDb(), {
    email: data.email,
    displayName: data.displayName,
    passwordHash,
  });
  if (!result.ok) {
    return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 });
  }
  return signedInResponse(req, result.user, { user: result.user });
}

async function signedInResponse(
  req: Request,
  user: { id: string; displayName: string },
  body: Record<string, unknown>
): Promise<NextResponse> {
  const seed = createGuestIdentity();
  const session = buildGuestSessionCookie(
    { gid: seed.gid, uid: user.id, name: user.displayName },
    getSessionSecret(),
    { secure: process.env.NODE_ENV === 'production' }
  );
  // beta-review (S7): awaited — the session must be listable (and so
  // revocable by a password change) before the cookie is handed out.
  // A failure only logs: this session belongs to the account being
  // created (no stolen-credential vector), and failing here would strand
  // a just-created account behind a 409 on retry.
  try {
    await recordSession(user.id, seed.gid, req);
  } catch (error) {
    console.error('[auth/register] session tracking failed', (error as Error).message);
  }
  return NextResponse.json(body, {
    status: 201,
    headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' },
  });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  maxBodyBytes: 4 * 1024,
  rateLimit: { identifier: 'auth-local-register', config: { windowMs: 15 * 60_000, maxRequests: 5 } },
});
