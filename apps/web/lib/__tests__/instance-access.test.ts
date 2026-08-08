import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getEffectiveInstanceAccessSettings, getInviteMetadata } = vi.hoisted(() => ({
  getEffectiveInstanceAccessSettings: vi.fn(),
  getInviteMetadata: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getEffectiveInstanceAccessSettings,
  getInviteMetadata,
}));

import { authorizeGuestRegistration } from '@/lib/instance-access';

const db = {} as never;

function settings(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'self-host',
    registrationMode: 'invite_only',
    guestAccessEnabled: true,
    seoIndexingEnabled: false,
    updatedAt: null,
    ...overrides,
  };
}

describe('instance guest registration access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings());
  });

  it('allows new guests when registration is open', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'open' }));
    await expect(authorizeGuestRegistration(db, {})).resolves.toMatchObject({ ok: true });
  });

  it('blocks all guest auth when guest access is disabled', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ guestAccessEnabled: false }));
    await expect(authorizeGuestRegistration(db, { existingUserId: 'user-1' })).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('blocks new registrations in closed mode but allows existing users', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'closed' }));
    await expect(authorizeGuestRegistration(db, {})).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(authorizeGuestRegistration(db, { existingUserId: 'user-1' })).resolves.toMatchObject({ ok: true });
  });

  it('requires an active invite in invite-only mode', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'invite_only' }));
    await expect(authorizeGuestRegistration(db, {})).resolves.toMatchObject({ ok: false, status: 400 });

    getInviteMetadata.mockResolvedValue({ isExpired: false, isExhausted: false });
    await expect(authorizeGuestRegistration(db, { inviteCode: '23456789ABCD' })).resolves.toMatchObject({ ok: true });
    expect(getInviteMetadata).toHaveBeenCalledWith(db, '23456789ABCD');
  });

  it('rejects expired or exhausted registration invites', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'invite_only' }));
    getInviteMetadata.mockResolvedValue({ isExpired: true, isExhausted: false });
    await expect(authorizeGuestRegistration(db, { inviteCode: '23456789ABCD' })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: 'Invite is unavailable.',
    });
  });
});
