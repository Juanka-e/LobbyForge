import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserById, updateUserProfile, UsernameTakenError } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { publishProfileChanged } from '@/lib/member-bus';
import {
  normalizeAccentColor,
  normalizePronouns,
  normalizeUsername,
  pronounsProblem,
  usernameProblem,
} from '@/lib/profile-fields';

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
    // 0050 (docs/PROFILES.md "Profile fields"). Lengths are bounded here only
    // loosely; the rules below give the precise, translatable reason.
    username: z.string().max(64).nullable().optional(),
    pronouns: z.string().max(80).nullable().optional(),
    accentColor: z.string().max(16).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one profile field is required.',
  });

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof ProfilePatchSchema>;
  try {
    body = ProfilePatchSchema.parse(await req.json());
  } catch {
    return refuse(400, 'invalid_profile', 'Invalid profile payload.');
  }

  const update: Parameters<typeof updateUserProfile>[2] = {};
  if (body.displayName !== undefined) update.displayName = body.displayName;
  if (body.statusText !== undefined) update.statusText = body.statusText;
  if (body.bio !== undefined) update.bio = body.bio;

  if (body.username !== undefined) {
    const username = body.username === null ? '' : normalizeUsername(body.username);
    if (username) {
      const problem = usernameProblem(username);
      if (problem) return refuse(400, `username_${problem}`, 'That username cannot be used.');
      // A guest account is temporary: a handle it took would be squatted
      // until the account is cleaned up.
      const user = await getUserById(getDb(), session.session.uid);
      if (user?.isGuest) return refuse(403, 'username_guest', 'Guest accounts cannot choose a username.');
    }
    update.username = username || null;
  }
  if (body.pronouns !== undefined) {
    const pronouns = normalizePronouns(body.pronouns);
    const problem = pronouns ? pronounsProblem(pronouns) : null;
    if (problem) return refuse(400, `pronouns_${problem}`, 'Those pronouns cannot be used.');
    update.pronouns = pronouns;
  }
  if (body.accentColor !== undefined) {
    if (body.accentColor === null || body.accentColor.trim() === '') {
      update.accentColor = null;
    } else {
      const color = normalizeAccentColor(body.accentColor);
      if (!color) return refuse(400, 'accent_color_invalid', 'The profile colour must be a #rrggbb colour.');
      update.accentColor = color;
    }
  }

  let updated: Awaited<ReturnType<typeof updateUserProfile>>;
  try {
    updated = await updateUserProfile(getDb(), session.session.uid, update);
  } catch (error) {
    if (error instanceof UsernameTakenError) return refuse(409, 'username_taken', 'That username is taken.');
    throw error;
  }
  // docs/PROFILES.md "Live updates": every community the account is in re-reads it.
  publishProfileChanged(session.session.uid);
  return NextResponse.json(
    {
      user: {
        id: updated.id,
        displayName: updated.displayName,
        statusText: updated.statusText,
        bio: updated.bio,
        username: updated.username,
        pronouns: updated.pronouns,
        accentColor: updated.accentColor,
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
