/**
 * Role-gated channel visibility (0028) — REAL Postgres integration.
 *
 * These tests are skipped unless TEST_DATABASE_URL points at a scratch
 * postgres (CI's migration-check job exports one after migrating). The
 * pure-mocked route tests cover the gates; this suite proves the SQL
 * (override join across legacy + multi-role membership, empty-set
 * inheritance, replacement semantics) against actual queries.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const DB_URL = process.env.TEST_DATABASE_URL;
const dsn = DB_URL ?? 'postgres://postgres:lobbyforge_dev@127.0.0.1:5432/lobbyforge';

const sql = postgres(dsn, { max: 1 });
const enabled = Boolean(DB_URL);

let serverOwner: string;
let serverId: string;
let openChannel: string;
let privateChannel: string;
let memberNoRole: string;
let memberWithRole: string;
let roleId: string;

async function freshIds(): Promise<void> {
  serverOwner = randomUUID();
  serverId = randomUUID();
  openChannel = randomUUID();
  privateChannel = randomUUID();
  memberNoRole = randomUUID();
  memberWithRole = randomUUID();
  roleId = randomUUID();
}

describe.skipIf(!enabled)('channel visibility queries (integration)', () => {
  beforeAll(async () => {
    await freshIds();
    await sql`INSERT INTO users (id, display_name) VALUES (${serverOwner}, 'Owner'), (${memberNoRole}, 'NoRole'), (${memberWithRole}, 'HasRole')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'T', ${serverOwner})`;
    await sql`INSERT INTO channels (id, server_id, name, type) VALUES (${openChannel}, ${serverId}, 'open', 'text'), (${privateChannel}, ${serverId}, 'private', 'text')`;
    await sql`INSERT INTO roles (id, server_id, name, permissions) VALUES (${roleId}, ${serverId}, 'VIP', '[]'::jsonb)`;
    await sql`INSERT INTO memberships (server_id, user_id) VALUES (${serverId}, ${memberNoRole}), (${serverId}, ${memberWithRole})`;
    // memberWithRole holds the VIP role via membership_roles.
    const [m] = await sql`SELECT id FROM memberships WHERE server_id = ${serverId} AND user_id = ${memberWithRole}`;
    await sql`INSERT INTO membership_roles (membership_id, role_id) VALUES (${m.id}, ${roleId})`;
    // privateChannel is gated to VIP.
    await sql`INSERT INTO channel_role_overrides (channel_id, role_id) VALUES (${privateChannel}, ${roleId})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${serverOwner}, ${memberNoRole}, ${memberWithRole})`;
    await sql.end();
  });

  it('canMemberAccessChannel: open channel = everyone; gated = only role holders', async () => {
    const { createDb, canMemberAccessChannel } = await import('../index.js');
    const db = createDb(dsn);
    expect(await canMemberAccessChannel(db, serverId, openChannel, memberNoRole)).toBe(true);
    expect(await canMemberAccessChannel(db, serverId, privateChannel, memberNoRole)).toBe(false);
    expect(await canMemberAccessChannel(db, serverId, privateChannel, memberWithRole)).toBe(true);
  });

  it('listVisibleChannelsForMember filters gated channels out for non-holders', async () => {
    const { createDb, listVisibleChannelsForMember } = await import('../index.js');
    const db = createDb(dsn);
    const noRole = await listVisibleChannelsForMember(db, serverId, memberNoRole);
    expect(noRole.map((c) => c.id).sort()).toEqual([openChannel].sort());
    const vip = await listVisibleChannelsForMember(db, serverId, memberWithRole);
    expect(vip.map((c) => c.id).sort()).toEqual([openChannel, privateChannel].sort());
  });

  it('setChannelRoleOverrides([]) returns the channel to inherited visibility', async () => {
    const { createDb, setChannelRoleOverrides, canMemberAccessChannel } = await import('../index.js');
    const db = createDb(dsn);
    await setChannelRoleOverrides(db, privateChannel, []);
    expect(await canMemberAccessChannel(db, serverId, privateChannel, memberNoRole)).toBe(true);
    // restore for any later assertions
    await setChannelRoleOverrides(db, privateChannel, [roleId]);
  });
});
