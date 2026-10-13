/**
 * The profile card's queries (docs/PROFILES.md) against REAL Postgres.
 *
 *  - getMemberProfileRecord returns a current member with every held role
 *    (the legacy primary role folded in), and nothing for a member who
 *    left, was banned (even when the membership row survived the ban) or
 *    deleted their account;
 *  - listMutualServers lists the communities both users belong to, minus
 *    soft-deleted servers and servers where EITHER user holds an active
 *    ban; an expired ban no longer counts.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import { getMemberProfileRecord, listMutualServers } from '../queries/memberProfiles.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('member profiles (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const viewer = randomUUID();
  const subject = randomUUID();
  const deleted = randomUUID();
  const shared = randomUUID();
  const second = randomUUID();
  const subjectBanned = randomUUID();
  const viewerBanned = randomUUID();
  const expiredBan = randomUUID();
  const subjectLeft = randomUUID();
  const gone = randomUUID();
  const allServers = [shared, second, subjectBanned, viewerBanned, expiredBan, subjectLeft, gone];
  const everyoneRole = randomUUID();
  const modRole = randomUUID();
  const legacyRole = randomUUID();

  async function member(serverId: string, userId: string, roleId: string | null = null): Promise<string> {
    const [row] = await sql`INSERT INTO memberships (server_id, user_id, role_id) VALUES (${serverId}, ${userId}, ${roleId}) RETURNING id`;
    return row!.id as string;
  }

  beforeAll(async () => {
    await sql`INSERT INTO users (id, display_name) VALUES (${viewer}, 'Viewer'), (${subject}, 'Subject'), (${deleted}, 'Deleted')`;
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}`;
    const names: Record<string, string> = {
      [shared]: 'Alpha shared',
      [second]: 'Beta shared',
      [subjectBanned]: 'Subject banned',
      [viewerBanned]: 'Viewer banned',
      [expiredBan]: 'Gamma expired ban',
      [subjectLeft]: 'Subject left',
      [gone]: 'Deleted server',
    };
    for (const id of allServers) {
      await sql`INSERT INTO servers (id, name, owner_user_id, icon_url) VALUES (${id}, ${names[id]!}, ${viewer}, ${id === second ? 'https://cdn.example/beta.png' : id === shared ? 'data:image/png;base64,AAAA' : null})`;
    }
    await sql`UPDATE servers SET deleted_at = now() WHERE id = ${gone}`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions) VALUES
        (${everyoneRole}, ${shared}, '@everyone', 0, ${sql.json(['send_messages'])}),
        (${modRole}, ${shared}, 'Mods', 10, ${sql.json(['kick_members'])}),
        (${legacyRole}, ${shared}, 'Veteran', 5, ${sql.json([])})`;

    for (const id of allServers) await member(id, viewer);
    const subjectMembership = await member(shared, subject, legacyRole);
    await sql`INSERT INTO membership_roles (membership_id, role_id) VALUES (${subjectMembership}, ${everyoneRole}), (${subjectMembership}, ${modRole})`;
    await sql`UPDATE memberships SET nickname = 'Ace' WHERE id = ${subjectMembership}`;
    for (const id of [second, subjectBanned, viewerBanned, expiredBan, gone]) await member(id, subject);
    await member(shared, deleted);
    // Membership rows that outlived a ban (pre-fix data / a redeem race).
    await sql`INSERT INTO server_bans (server_id, user_id) VALUES (${subjectBanned}, ${subject}), (${viewerBanned}, ${viewer})`;
    await sql`INSERT INTO server_bans (server_id, user_id, expires_at) VALUES (${expiredBan}, ${subject}, now() - interval '1 day')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id IN ${sql(allServers)}`;
    await sql`DELETE FROM users WHERE id IN (${viewer}, ${subject}, ${deleted})`;
    await sql.end();
  });

  it('reads a current member with every held role, highest first', async () => {
    const record = await getMemberProfileRecord(db, shared, subject);
    expect(record).toMatchObject({
      userId: subject,
      globalDisplayName: 'Subject',
      nickname: 'Ace',
      avatarRef: null,
      profileVisibility: 'server_members',
      isGuest: false,
    });
    expect(record!.joinedAt).toBeInstanceOf(Date);
    expect(record!.accountCreatedAt).toBeInstanceOf(Date);
    expect(record!.roles.map((role) => role.name)).toEqual(['Mods', 'Veteran', '@everyone']);
    expect(record!.roles[0]!.permissions).toEqual(['kick_members']);
  });

  it('nothing for a member who left, is banned (row or not) or deleted their account', async () => {
    expect(await getMemberProfileRecord(db, subjectLeft, subject)).toBeNull();
    expect(await getMemberProfileRecord(db, subjectBanned, subject)).toBeNull();
    expect(await getMemberProfileRecord(db, shared, deleted)).toBeNull();
    expect(await getMemberProfileRecord(db, gone, subject)).toBeNull();
    // An expired ban is inert.
    expect(await getMemberProfileRecord(db, expiredBan, subject)).not.toBeNull();
  });

  it('mutual communities: both members, a live server, neither actively banned', async () => {
    const result = await listMutualServers(db, viewer, subject);
    expect(result.servers.map((s) => s.id)).toEqual([shared, second, expiredBan]);
    expect(result.total).toBe(3);
    // https icons pass, a data URL never leaves Postgres.
    expect(result.servers.find((s) => s.id === second)!.iconUrl).toBe('https://cdn.example/beta.png');
    expect(result.servers.find((s) => s.id === shared)!.iconUrl).toBeNull();
    // Symmetric.
    const reverse = await listMutualServers(db, subject, viewer);
    expect(reverse.servers.map((s) => s.id).sort()).toEqual([shared, second, expiredBan].sort());
  });

  it('a limit trims the list but not the total', async () => {
    const result = await listMutualServers(db, viewer, subject, { limit: 1 });
    expect(result.servers).toHaveLength(1);
    expect(result.total).toBe(3);
  });
});
