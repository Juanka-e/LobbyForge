import { describe, expect, it } from 'vitest';
import { displayRoleOf } from '@/lib/display-role';

const EVERYONE = { id: 'r-everyone', name: '@everyone', position: 0 };
const MOD = { id: 'r-mod', name: 'Moderator', position: 5 };
const VIP = { id: 'r-vip', name: 'VIP', position: 2 };

describe('displayRoleOf — the role a member is shown with', () => {
  it('is the highest role other than @everyone, wherever @everyone sits in the set', () => {
    expect(displayRoleOf([EVERYONE, VIP, MOD])).toBe(MOD);
    expect(displayRoleOf([VIP, EVERYONE])).toBe(VIP);
  });

  it('is null for @everyone alone or no role (the page says Member or Guest)', () => {
    expect(displayRoleOf([EVERYONE])).toBeNull();
    expect(displayRoleOf([])).toBeNull();
  });

  it('gives a tie to the role listed first, like the server', () => {
    const twin = { id: 'r-twin', name: 'Twin', position: 5 };
    expect(displayRoleOf([twin, MOD])).toBe(twin);
  });
});
