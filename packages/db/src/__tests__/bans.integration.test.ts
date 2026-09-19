/**
 * beta-review (S2) — bans must REVOKE access, proven against real
 * Postgres. Live-confirmed bug: `banUser` only inserted the ban row, so
 * the banned user kept their membership (messages 201, LiveKit token
 * 200). These tests pin:
 *   - banUser deletes the membership (+ membership_roles cascade) in the
 *     same transaction as the ban insert;
 *   - a membership row that SURVIVED a ban (pre-fix data / redeem race)
 *     no longer counts: isServerMember=false, getUserPermissions=[],
 *     ensureServerMembership refuses, redeemInvite says "banned";
 *   - an EXPIRED ban is inert, and re-banning refreshes the row.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  banUser,
  isCurrentlyBanned,
  listActivelyBannedServerIds,
} from '../queries/bans.js';
import { ensureServerMembership, isServerMember } from '../queries/memberships.js';
import { getUserPermissions } from '../queries/roles.js';
import { redeemInvite } from '../queries/invites.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('bans revoke access (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const mod = randomUUID();
  const target = randomUUID();
  const lingering = randomUUID();
  const expired = randomUUID();
  const serverId = randomUUID();
  const everyoneRoleId = randomUUID();
  const inviteCode = `BR${randomUUID().replace(/[^0-9]/g, '').slice(0, 10).padEnd(10, '2')}`
    .replace(/[01]/g, '2')
    .toUpperCase();

  async function addMember(userId: string): Promise<void> {
    const [m] = await sql`
      INSERT INTO memberships (server_id, user_id, role_id)
      VALUES (${serverId}, ${userId}, ${everyoneRoleId})
      RETURNING id`;
    await sql`INSERT INTO membership_roles (membership_id, role_id) VALUES (${m!.id}, ${everyoneRoleId})`;
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO users (id, display_name) VALUES
        (${owner}, 'Owner'), (${mod}, 'Mod'), (${target}, 'Target'),
        (${lingering}, 'Lingering'), (${expired}, 'Expired')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'BanTest', ${owner})`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions)
      VALUES (${everyoneRoleId}, ${serverId}, '@everyone', 0, '["send_messages","read_message_history"]'::jsonb)`;
    await addMember(mod);
    await addMember(target);
    await addMember(lingering);
    await addMember(expired);
    await sql`INSERT INTO invites (server_id, created_by, code) VALUES (${serverId}, ${owner}, ${inviteCode})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${mod}, ${target}, ${lingering}, ${expired})`;
    await sql.end();
  });

  it('banUser removes the membership and its role links atomically', async () => {
    expect(await isServerMember(db, target, serverId)).toBe(true);
    const result = await banUser(db, { serverId, userId: target, bannedBy: mod, reason: 'spam' });
    expect(result.ok).toBe(true);

    const rows = await sql`SELECT id FROM memberships WHERE server_id = ${serverId} AND user_id = ${target}`;
    expect(rows).toHaveLength(0);
    const links = await sql`
      SELECT mr.id FROM membership_roles mr
      JOIN memberships m ON m.id = mr.membership_id
      WHERE m.server_id = ${serverId} AND m.user_id = ${target}`;
    expect(links).toHaveLength(0);
    expect(await isServerMember(db, target, serverId)).toBe(false);
    expect(await getUserPermissions(db, target, serverId)).toEqual([]);
    expect(await isCurrentlyBanned(db, serverId, target)).toBe(true);
  });

  it('re-banning an actively banned user is idempotent', async () => {
    const again = await banUser(db, { serverId, userId: target, bannedBy: mod });
    expect(again.ok).toBe(true);
    const bans = await sql`SELECT id FROM server_bans WHERE server_id = ${serverId} AND user_id = ${target}`;
    expect(bans).toHaveLength(1);
  });

  it('refuses to ban the server owner', async () => {
    const result = await banUser(db, { serverId, userId: owner, bannedBy: mod });
    expect(result).toEqual({ ok: false, error: 'cannot_ban_owner' });
  });

  it('a membership that survived a ban grants nothing', async () => {
    // Pre-fix data shape: ban row present, membership row still there.
    await sql`INSERT INTO server_bans (server_id, user_id, banned_by) VALUES (${serverId}, ${lingering}, ${mod})`;
    expect(await isServerMember(db, lingering, serverId)).toBe(false);
    expect(await getUserPermissions(db, lingering, serverId)).toEqual([]);
    expect(await ensureServerMembership(db, serverId, lingering)).toBeNull();
    // The ban check runs BEFORE the "already a member" probe.
    expect(await redeemInvite(db, inviteCode, lingering)).toEqual({ ok: false, error: 'banned' });
    expect(await listActivelyBannedServerIds(db, lingering, [serverId])).toEqual(new Set([serverId]));
  });

  it('ensureServerMembership does not re-join a banned (removed) user', async () => {
    expect(await ensureServerMembership(db, serverId, target)).toBeNull();
    const rows = await sql`SELECT id FROM memberships WHERE server_id = ${serverId} AND user_id = ${target}`;
    expect(rows).toHaveLength(0);
  });

  it('an expired ban is inert, and re-banning refreshes it', async () => {
    const past = new Date(Date.now() - 60_000);
    await sql`
      INSERT INTO server_bans (server_id, user_id, banned_by, expires_at)
      VALUES (${serverId}, ${expired}, ${mod}, ${past})`;
    expect(await isServerMember(db, expired, serverId)).toBe(true);
    expect((await getUserPermissions(db, expired, serverId)).length).toBeGreaterThan(0);
    expect(await listActivelyBannedServerIds(db, expired)).toEqual(new Set());

    const result = await banUser(db, { serverId, userId: expired, bannedBy: mod, reason: 'again' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ban.expiresAt).toBeNull();
      expect(result.ban.reason).toBe('again');
    }
    expect(await isCurrentlyBanned(db, serverId, expired)).toBe(true);
    expect(await isServerMember(db, expired, serverId)).toBe(false);
  });
});
