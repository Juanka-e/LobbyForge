import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEffectiveUserSettings,
  updateUserAudio,
  updateUserNotifications,
  updateUserKeybinds,
  updateUserPrivacySettings,
  updateUserTheme,
  type UserPrivacySettings,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VisibilityScopeSchema = z.enum(['everyone', 'server_members', 'friends', 'nobody']);

const ThemeSchema = z.enum(['dark', 'dim', 'light', 'system']);

const PrivacySchema = z
  .object({
    profileVisibility: VisibilityScopeSchema,
    onlineStatusVisibility: VisibilityScopeSchema,
    activityVisibility: VisibilityScopeSchema,
    showCurrentGame: z.boolean(),
    showMusicStatus: z.boolean(),
    showWatchPartyStatus: z.boolean(),
    showServerNameInActivity: z.boolean(),
  })
  .strict();

const FlatPreferenceValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const PreferenceKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const PreferenceRecordSchema = z
  .record(PreferenceKeySchema, FlatPreferenceValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preference object contains too many keys.',
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preference object is too large.',
      });
    }
  });

const KeybindActionSchema = z.enum([
  'pushToTalk',
  'toggleMute',
  'toggleDeafen',
  'toggleCamera',
  'toggleScreenShare',
]);

const KeybindRecordSchema = z
  .record(
    KeybindActionSchema,
    z.object({
      code: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
      label: z.string().min(1).max(64),
    }).strict()
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Too many keybinds.',
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Keybind preferences are too large.',
      });
    }
  });

const PatchSchema = z
  .object({
    privacy: PrivacySchema.optional(),
    theme: ThemeSchema.optional(),
    notifications: PreferenceRecordSchema.optional(),
    audio: PreferenceRecordSchema.optional(),
    keybinds: KeybindRecordSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.privacy !== undefined ||
      value.theme !== undefined ||
      value.notifications !== undefined ||
      value.audio !== undefined ||
      value.keybinds !== undefined,
    { message: 'PATCH body must include at least one settings field' }
  );

function toJson(settings: Awaited<ReturnType<typeof getEffectiveUserSettings>>) {
  return {
    settings: {
      theme: settings.theme,
      notifications: settings.notifications,
      audio: settings.audio,
      privacy: settings.privacy,
      keybinds: settings.keybinds,
      updatedAt: settings.updatedAt.toISOString(),
    },
  };
}

async function handleGet(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  // Fire-and-forget: refresh the session fingerprint on settings page loads.
  void recordSession(session.session.uid, session.session.gid, req);
  const settings = await getEffectiveUserSettings(getDb(), session.session.uid);
  return NextResponse.json(toJson(settings), { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let parsed: z.infer<typeof PatchSchema>;
  try {
    const body = (await req.json()) as unknown;
    parsed = PatchSchema.parse(body);
  } catch {
    return NextResponse.json(
      { error: 'Invalid settings payload' },
      { status: 400 }
    );
  }

  const db = getDb();
  const uid = session.session.uid;
  // Apply patches in sequence. Each helper is an upsert so the
  // settings row is created on demand; we re-fetch after each so
  // the response always reflects the latest merged row.
  let settings = await getEffectiveUserSettings(db, uid);
  if (parsed.privacy) {
    settings = await updateUserPrivacySettings(db, uid, parsed.privacy as UserPrivacySettings);
  }
  if (parsed.theme) {
    settings = await updateUserTheme(db, uid, parsed.theme);
  }
  if (parsed.notifications) {
    settings = await updateUserNotifications(db, uid, parsed.notifications);
  }
  if (parsed.audio) {
    settings = await updateUserAudio(db, uid, parsed.audio);
  }
  if (parsed.keybinds) {
    settings = await updateUserKeybinds(db, uid, parsed.keybinds);
  }
  return NextResponse.json(toJson(settings), { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'settings-me-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'settings-me-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
