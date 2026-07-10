import {
  getEffectiveInstanceAccessSettings,
  getInviteMetadata,
  type DbClient,
  type InstanceAccessSettings,
} from '@lobbyforge/db';

export type GuestRegistrationAccess =
  | { ok: true; settings: InstanceAccessSettings }
  | { ok: false; status: 400 | 403 | 410; error: string };

export async function authorizeGuestRegistration(
  db: DbClient,
  input: { existingUserId?: string | null; inviteCode?: string }
): Promise<GuestRegistrationAccess> {
  const settings = await getEffectiveInstanceAccessSettings(db);
  if (!settings.guestAccessEnabled) {
    return { ok: false, status: 403, error: 'Guest access is disabled on this instance.' };
  }

  if (input.existingUserId) return { ok: true, settings };
  if (settings.registrationMode === 'closed') {
    return { ok: false, status: 403, error: 'New registrations are closed on this instance.' };
  }
  if (settings.registrationMode !== 'invite_only') return { ok: true, settings };

  const code = input.inviteCode?.trim().toUpperCase();
  if (!code || !/^[A-Z2-9]{6,16}$/.test(code)) {
    return { ok: false, status: 400, error: 'A valid invite code is required to register.' };
  }
  const invite = await getInviteMetadata(db, code);
  if (!invite) return { ok: false, status: 403, error: 'Invite is not valid for registration.' };
  if (invite.isExpired || invite.isExhausted) {
    return { ok: false, status: 410, error: 'Invite is no longer active.' };
  }
  return { ok: true, settings };
}
