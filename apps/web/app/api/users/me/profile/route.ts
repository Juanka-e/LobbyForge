import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserProfile } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** C0/C1 control characters (CR/LF, U+0085 …): refused like DisplayNameSchema does at sign-up. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

const ProfilePatchSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .refine((name) => !CONTROL_CHARACTERS.test(name), 'Display name must not contain control characters')
      .optional(),
    statusText: z.string().trim().max(128).nullable().optional(),
    bio: z.string().trim().max(190).nullable().optional(),
  })
  .strict()
  .refine((value) => value.displayName !== undefined || value.statusText !== undefined || value.bio !== undefined, {
    message: 'At least one profile field is required.',
  });

async function handlePatch(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof ProfilePatchSchema>;
  try {
    body = ProfilePatchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid profile payload.' }, { status: 400 });
  }

  const updated = await updateUserProfile(getDb(), session.session.uid, body);
  return NextResponse.json(
    {
      user: {
        id: updated.id,
        displayName: updated.displayName,
        statusText: updated.statusText,
        bio: updated.bio,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'user-profile-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
