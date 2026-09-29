import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOT_PERMISSIONS,
  BOT_PERMISSION_REQUIRES,
  BUILT_IN_BOT_PERMISSIONS,
  botHasPermission,
  botTrustLevel,
  findUngrantableBotPermissions,
  isBotPermission,
  moderationBlockedMessageKey,
} from '../permissions';

describe('bot permission vocabulary', () => {
  it('is exactly the SDK BotPermission list (apps/web keeps its own copy)', () => {
    const sdk = readFileSync(join(process.cwd(), '..', '..', 'packages', 'bot-sdk', 'src', 'index.ts'), 'utf8');
    const block = /export const BotPermission = \{([\s\S]*?)\} as const;/.exec(sdk)?.[1] ?? '';
    const values = Array.from(block.matchAll(/:\s*'([a-z_]+)'/g), (m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    expect([...BOT_PERMISSIONS].sort()).toEqual([...values].sort());
  });

  it('never contains a member/admin permission', () => {
    expect(isBotPermission('administrator')).toBe(false);
    expect(isBotPermission('manage_server')).toBe(false);
    expect(BOT_PERMISSIONS).not.toContain('administrator');
  });

  it('maps every bot permission to a grant requirement', () => {
    for (const permission of BOT_PERMISSIONS) {
      expect(permission in BOT_PERMISSION_REQUIRES).toBe(true);
    }
  });

  it('gives built-in bots only what they need', () => {
    expect(BUILT_IN_BOT_PERMISSIONS.welcome).toEqual(['send_messages']);
    expect(BUILT_IN_BOT_PERMISSIONS.moderation).toContain('moderate_messages');
    expect(BUILT_IN_BOT_PERMISSIONS.moderation).not.toContain('read_audit_log');
  });

  it('checks a bot permission exactly', () => {
    expect(botHasPermission({ permissions: ['send_messages'] }, 'send_messages')).toBe(true);
    expect(botHasPermission({ permissions: ['send_messages'] }, 'read_messages')).toBe(false);
  });
});

describe('findUngrantableBotPermissions', () => {
  it('lets the owner and administrators grant any bot permission', () => {
    expect(
      findUngrantableBotPermissions({ actorIsOwner: true, actorPermissions: [], requested: [...BOT_PERMISSIONS] })
    ).toEqual([]);
    expect(
      findUngrantableBotPermissions({
        actorIsOwner: false,
        actorPermissions: ['administrator'],
        requested: [...BOT_PERMISSIONS],
      })
    ).toEqual([]);
  });

  it('stops a manager from giving a bot more than they have', () => {
    expect(
      findUngrantableBotPermissions({
        actorIsOwner: false,
        actorPermissions: ['manage_server', 'send_messages'],
        requested: ['send_messages', 'read_audit_log', 'moderate_messages', 'read_presence'],
      })
    ).toEqual(['read_audit_log', 'moderate_messages']);
  });

  it('only polices additions', () => {
    expect(
      findUngrantableBotPermissions({
        actorIsOwner: false,
        actorPermissions: ['manage_server'],
        requested: ['read_audit_log'],
        alreadyGranted: ['read_audit_log'],
      })
    ).toEqual([]);
  });

  it('always refuses ids that are not bot permissions — even for the owner', () => {
    expect(
      findUngrantableBotPermissions({ actorIsOwner: true, actorPermissions: [], requested: ['administrator'] })
    ).toEqual(['administrator']);
  });
});

describe('trust and messages', () => {
  it('marks built-ins official and custom bots unverified', () => {
    expect(botTrustLevel('welcome')).toBe('official');
    expect(botTrustLevel('moderation')).toBe('official');
    expect(botTrustLevel('custom')).toBe('unverified');
    expect(botTrustLevel('internal-demo')).toBe('official');
  });

  it('maps every moderation rule to its message key', () => {
    expect(moderationBlockedMessageKey('blocked_word')).toBe('bots.moderation.blocked.blocked_word');
    expect(moderationBlockedMessageKey('flood')).toBe('bots.moderation.blocked.flood');
    expect(moderationBlockedMessageKey('whatever')).toBe('bots.moderation.blocked.generic');
  });
});
