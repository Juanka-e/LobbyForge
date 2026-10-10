import { describe, it, expect } from 'vitest';
import { hasPermission, CorePermission } from '../permissions.js';

describe('Permissions utility', () => {
  it('should grant permission if exact permission matches', () => {
    const userPerms = [CorePermission.SEND_MESSAGES, CorePermission.CONNECT_VOICE];
    expect(hasPermission(userPerms, CorePermission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(userPerms, CorePermission.CONNECT_VOICE)).toBe(true);
    expect(hasPermission(userPerms, CorePermission.BAN_MEMBERS)).toBe(false);
  });

  it('should bypass checks for administrator role', () => {
    const adminPerms = [CorePermission.ADMINISTRATOR];
    expect(hasPermission(adminPerms, CorePermission.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(adminPerms, CorePermission.MANAGE_SERVER)).toBe(true);
  });

  it('create_polls is its own permission: sending messages does not imply it, administrator does', () => {
    expect(CorePermission.CREATE_POLLS).toBe('create_polls');
    expect(hasPermission([CorePermission.SEND_MESSAGES], CorePermission.CREATE_POLLS)).toBe(false);
    expect(hasPermission([CorePermission.CREATE_POLLS], CorePermission.CREATE_POLLS)).toBe(true);
    expect(hasPermission([CorePermission.ADMINISTRATOR], CorePermission.CREATE_POLLS)).toBe(true);
  });
});
