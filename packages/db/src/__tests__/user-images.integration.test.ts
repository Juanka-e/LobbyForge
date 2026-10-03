/**
 * security-review FILE-001 / AUTHZ-005 against REAL Postgres.
 *
 * The image route's access query is a single-table select, where Drizzle
 * renders columns unqualified: `users.id` inside its subqueries became a
 * bare "id" — ambiguous in the memberships subquery (every avatar and
 * banner request 500'd in the e2e stack) and silently `user_settings.id`
 * in the settings subquery. The unit tests used a fake client, so only a
 * real database proves the SQL.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import { getUserImageAccess, getUserImageData } from '../queries/userImages.js';
import { listMemberSummariesForServer } from '../queries/memberships.js';
import { updateUserAvatar } from '../queries/users.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

describeIf('REAL Postgres: user image access', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);
  const subject = randomUUID();
  const sameServerViewer = randomUUID();
  const stranger = randomUUID();
  const serverId = randomUUID();
  const avatar = `data:image/png;base64,${'A'.repeat(400)}`;

  beforeAll(async () => {
    for (const [id, name] of [[subject, 'Subject'], [sameServerViewer, 'Peer'], [stranger, 'Stranger']] as const) {
      await sql`INSERT INTO users (id, email, password_hash, display_name) VALUES (${id}, ${`${id}@img.test`}, 'x', ${name})`;
    }
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'Images', ${subject})`;
    await sql`INSERT INTO memberships (server_id, user_id) VALUES (${serverId}, ${subject}), (${serverId}, ${sameServerViewer})`;
    await updateUserAvatar(db, subject, avatar);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${subject}, ${sameServerViewer}, ${stranger})`;
    await sql.end();
  });

  async function setVisibility(value: string | null) {
    await sql`DELETE FROM user_settings WHERE user_id = ${subject}`;
    if (value) {
      await sql`INSERT INTO user_settings (user_id, privacy) VALUES (${subject}, ${sql.json({ profileVisibility: value })})`;
    }
  }

  it('resolves access without an ambiguous column, for a peer and a stranger', async () => {
    await setVisibility(null);
    const peer = await getUserImageAccess(db, { userId: subject, viewerUserId: sameServerViewer, kind: 'avatar' });
    const other = await getUserImageAccess(db, { userId: subject, viewerUserId: stranger, kind: 'avatar' });
    expect(peer).toMatchObject({ hasImage: true, sharesServer: true });
    expect(other).toMatchObject({ hasImage: true, sharesServer: false });
  });

  it('reads the SUBJECT’s visibility, not whatever row matches a bare "id"', async () => {
    await setVisibility('nobody');
    const access = await getUserImageAccess(db, { userId: subject, viewerUserId: sameServerViewer, kind: 'avatar' });
    expect(access?.profileVisibility).toBe('nobody');
    await setVisibility('everyone');
    const open = await getUserImageAccess(db, { userId: subject, viewerUserId: stranger, kind: 'avatar' });
    expect(open?.profileVisibility).toBe('everyone');
  });

  it('serves the stored value with the same reference the member list hands out', async () => {
    const data = await getUserImageData(db, subject, 'avatar');
    expect(data?.value).toBe(avatar);
    const members = await listMemberSummariesForServer(db, serverId);
    const row = members.find((m) => m.userId === subject) as unknown as { avatarRef?: string | null };
    expect(row?.avatarRef).toBe(data?.ref);
    expect(JSON.stringify(members)).not.toContain('data:image');
  });

  it('a missing banner is no image, not an error', async () => {
    const access = await getUserImageAccess(db, { userId: subject, viewerUserId: sameServerViewer, kind: 'banner' });
    expect(access?.hasImage).toBe(false);
    expect(await getUserImageData(db, subject, 'banner')).toBeNull();
  });
});
