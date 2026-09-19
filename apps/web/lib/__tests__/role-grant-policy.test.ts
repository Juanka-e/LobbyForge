import { describe, expect, it } from 'vitest';
import { findUngrantablePermissions } from '../role-grant-policy';

describe('findUngrantablePermissions (beta-review S1)', () => {
  it('the owner may grant anything, including administrator', () => {
    expect(
      findUngrantablePermissions({ actorIsOwner: true, actorPermissions: [], requested: ['administrator', 'ban_members'] })
    ).toEqual([]);
  });

  it('a non-owner never grants administrator — even an administrator', () => {
    expect(
      findUngrantablePermissions({ actorIsOwner: false, actorPermissions: ['administrator'], requested: ['administrator'] })
    ).toEqual(['administrator']);
  });

  it('a non-owner may only add permissions they hold (administrator holds the rest)', () => {
    expect(
      findUngrantablePermissions({
        actorIsOwner: false,
        actorPermissions: ['manage_roles', 'kick_members'],
        requested: ['kick_members', 'ban_members', 'view_audit_log'],
      })
    ).toEqual(['ban_members', 'view_audit_log']);
    expect(
      findUngrantablePermissions({
        actorIsOwner: false,
        actorPermissions: ['administrator'],
        requested: ['ban_members', 'view_audit_log'],
      })
    ).toEqual([]);
  });

  it('permissions the role already carries are not a new grant', () => {
    expect(
      findUngrantablePermissions({
        actorIsOwner: false,
        actorPermissions: ['manage_roles'],
        requested: ['administrator', 'ban_members'],
        alreadyGranted: ['administrator', 'ban_members'],
      })
    ).toEqual([]);
  });

  it('tolerates a missing permission list', () => {
    expect(findUngrantablePermissions({ actorIsOwner: false, actorPermissions: [], requested: undefined })).toEqual([]);
  });
});
