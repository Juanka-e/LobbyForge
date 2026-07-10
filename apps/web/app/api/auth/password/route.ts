import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters.')
    .max(256),
});

/**
 * Local-account password change endpoint. This milestone wires the UI
 * but does not yet store password hashes — the route validates the
 * payload and returns 501 so the client surfaces a "not yet available"
 * message. Once password auth is implemented (M22+), the handler will
 * verify the current password, hash the new one, and persist it.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let parsed: z.infer<typeof BodySchema>;
  try {
    const body = (await req.json()) as unknown;
    parsed = BodySchema.parse(body);
  } catch {
    return NextResponse.json(
      { error: 'Invalid password payload' },
      { status: 400 }
    );
  }

  if (parsed.currentPassword === parsed.newPassword) {
    return NextResponse.json(
      { error: 'New password must differ from the current one.' },
      { status: 400 }
    );
  }

  // Placeholder — wire up password hashing in the auth milestone.
  return NextResponse.json(
    {
      error:
        'Password change will land with the local-account auth milestone. Your password was accepted but not yet stored.',
    },
    { status: 501 }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'auth-password', config: { windowMs: 60_000, maxRequests: 5 } },
});
