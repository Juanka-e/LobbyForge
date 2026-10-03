import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserCredentialsById, replaceUserPasswordHash } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { revokeDesktopHandoffCodes } from '@/lib/desktop-handoff-codes';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';
import { revokeOtherSessions } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12, 'New password must be at least 12 characters.').max(128),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const result = BodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json(
      { error: result.error.issues[0]?.message ?? 'Invalid password payload.' },
      { status: 400 }
    );
  }
  const input = result.data;
  if (input.currentPassword === input.newPassword) {
    return NextResponse.json(
      { error: 'New password must differ from the current one.' },
      { status: 400 }
    );
  }

  const credentials = await getUserCredentialsById(getDb(), session.session.uid);
  const currentHash = credentials?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const currentPasswordValid = await verifyPassword(input.currentPassword, currentHash);
  if (
    !credentials ||
    credentials.deletedAt ||
    credentials.isGuest ||
    !credentials.passwordHash ||
    !currentPasswordValid
  ) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 403 });
  }

  const newPasswordHash = await hashPassword(input.newPassword);
  const updated = await replaceUserPasswordHash(getDb(), {
    userId: credentials.id,
    currentPasswordHash: credentials.passwordHash,
    newPasswordHash,
  });
  if (!updated) {
    return NextResponse.json(
      { error: 'Password changed in another session. Sign in again and retry.' },
      { status: 409 }
    );
  }

  // security-review AUTH-001: desktop handoff codes minted under the old
  // password are already void (completion checks the credential
  // fingerprint); deleting them here is the second, best-effort guard.
  await revokeDesktopHandoffCodes(credentials.id).catch((error) => {
    console.error('[auth/password] failed to clear desktop handoff codes', (error as Error).message);
  });

  try {
    await revokeOtherSessions(credentials.id, session.session.gid);
  } catch (error) {
    console.error('[auth/password] failed to revoke other sessions', (error as Error).message);
    // security-review AUTH-001: the point of changing a password is often
    // to throw someone out, so plain success while their session lives on
    // would mislead. But the password WAS changed: an error status (the
    // 503 this used to be) made the dialog report failure — in English,
    // whatever the user's language — and invited a retry with the old
    // password. It is a success with a machine-readable warning that the
    // client words in the viewer's language (every environment alike).
    return NextResponse.json(
      { status: 'changed', warning: 'sessions_not_revoked' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    { status: 'changed' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'auth-password', config: { windowMs: 15 * 60_000, maxRequests: 5 } },
});
