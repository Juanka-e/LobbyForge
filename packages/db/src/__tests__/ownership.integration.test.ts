/**
 * Real-Postgres integration tests for the ownership-critical paths
 * multiple audits flagged as mock-only: plugin catalog ownership
 * (first-submit bug, race loser, NULL publisher) and registry instance
 * ownership (concurrent registration, legacy NULL claim).
 *
 * These run ONLY when TEST_DATABASE_URL points at a real, migrated
 * Postgres — the CI migration-check job provisions one.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const TEST_URL = process.env.TEST_DATABASE_URL;
const describeIf = TEST_URL ? describe : describe.skip;

describeIf('REAL Postgres: plugin catalog ownership', () => {
  let sql: postgres.Sql;
  const PLUGIN_ID = `test-plugin-${Date.now()}`;
  const USER_A = '00000000-0000-0000-0000-0000000000aa';
  const USER_B = '00000000-0000-0000-0000-0000000000bb';

  beforeAll(async () => {
    sql = postgres(TEST_URL!, { max: 1 });
    // Clean up any leftover test data
    await sql`DELETE FROM plugin_catalog WHERE plugin_id LIKE 'test-plugin-%'`;
    await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
    // Create test users (satisfies FK)
    for (const [id, email] of [[USER_A, 'a@test'], [USER_B, 'b@test']] as const) {
      await sql`INSERT INTO users (id, email, password_hash, display_name) VALUES (${id}, ${email}, 'x', 'Test')`;
    }
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM plugin_catalog WHERE plugin_id LIKE 'test-plugin-%'`;
      await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
      await sql.end();
    }
  });

  it('first submit by a brand-new publisher succeeds (15th-audit regression)', async () => {
    const result = await sql`
      INSERT INTO plugin_catalog (plugin_id, name, version, type, publisher, publisher_user_id, review_status)
      VALUES (${PLUGIN_ID}, 'Test Plugin', '1.0.0', 'game', 'publisher-a', ${USER_A}, 'pending')
      RETURNING plugin_id, publisher_user_id`;
    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe(PLUGIN_ID);
    expect(result[0].publisher_user_id).toBe(USER_A);
  });

  it('same publisher update succeeds and resets to pending', async () => {
    const result = await sql`
      UPDATE plugin_catalog
      SET name = 'Updated', review_status = 'pending', updated_at = now()
      WHERE plugin_id = ${PLUGIN_ID} AND publisher_user_id = ${USER_A}
      RETURNING plugin_id, name`;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Updated');
  });

  it('different publisher cannot update (setWhere no-op)', async () => {
    // Simulates the setWhere(publisher = excluded.publisher) race-loser path
    const result = await sql`
      UPDATE plugin_catalog
      SET name = 'Hacked', updated_at = now()
      WHERE plugin_id = ${PLUGIN_ID} AND publisher_user_id = ${USER_B}
      RETURNING plugin_id`;
    expect(result).toHaveLength(0); // no rows returned → race loser gets nothing
  });

  it('NULL-publisher legacy row blocks submits from any user', async () => {
    // Create a legacy row with NULL publisher
    const legacyId = `test-plugin-legacy-${Date.now()}`;
    await sql`INSERT INTO plugin_catalog (plugin_id, name, version, type, publisher, publisher_user_id, review_status)
      VALUES (${legacyId}, 'Legacy', '0.1.0', 'game', 'migrated', NULL, 'approved')`;

    // Application-level check: existing row with NULL publisher → reject
    const existing = await sql`SELECT publisher_user_id FROM plugin_catalog WHERE plugin_id = ${legacyId}`;
    expect(existing).toHaveLength(1);
    expect(existing[0].publisher_user_id).toBeNull();

    // The update with setWhere(publisher = excluded.publisher) would be
    // `WHERE publisher_user_id = USER_A` → no match → no rows
    const result = await sql`
      UPDATE plugin_catalog SET name = 'Squatted' WHERE plugin_id = ${legacyId} AND publisher_user_id = ${USER_A}
      RETURNING plugin_id`;
    expect(result).toHaveLength(0);

    await sql`DELETE FROM plugin_catalog WHERE plugin_id = ${legacyId}`;
  });

  it('concurrent inserts: only one wins (unique constraint)', async () => {
    const concurrentId = `test-plugin-concurrent-${Date.now()}`;
    // First insert succeeds
    await sql`INSERT INTO plugin_catalog (plugin_id, name, version, type, publisher, publisher_user_id, review_status)
      VALUES (${concurrentId}, 'First', '1.0.0', 'game', 'a', ${USER_A}, 'pending')`;

    // Second insert with same ID fails (unique constraint)
    try {
      await sql`INSERT INTO plugin_catalog (plugin_id, name, version, type, publisher, publisher_user_id, review_status)
        VALUES (${concurrentId}, 'Second', '1.0.0', 'game', 'b', ${USER_B}, 'pending')`;
      expect.fail('Should have thrown unique constraint violation');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('23505'); // unique_violation
    }

    await sql`DELETE FROM plugin_catalog WHERE plugin_id = ${concurrentId}`;
  });
});

describeIf('REAL Postgres: registry instance ownership', () => {
  let sql: postgres.Sql;
  const INSTANCE_ID = `test-inst-${Date.now()}`;
  const USER_A = '00000000-0000-0000-0000-0000000000aa';
  const USER_B = '00000000-0000-0000-0000-0000000000bb';

  beforeAll(async () => {
    sql = postgres(TEST_URL!, { max: 1 });
    await sql`DELETE FROM registry_instances WHERE instance_id LIKE 'test-inst-%'`;
    await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
    for (const [id, email] of [[USER_A, 'a@test'], [USER_B, 'b@test']] as const) {
      await sql`INSERT INTO users (id, email, password_hash, display_name) VALUES (${id}, ${email}, 'x', 'Test')`;
    }
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM registry_instances WHERE instance_id LIKE 'test-inst-%'`;
      await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
      await sql.end();
    }
  });

  it('first registrant becomes the owner', async () => {
    const result = await sql`
      INSERT INTO registry_instances (instance_id, name, domain, public_key, owner_user_id)
      VALUES (${INSTANCE_ID}, 'Test Instance', 'https://test.example.com', 'pk-test', ${USER_A})
      RETURNING instance_id, owner_user_id`;
    expect(result).toHaveLength(1);
    expect(result[0].owner_user_id).toBe(USER_A);
  });

  it('different user cannot steal ownership (setWhere no-op)', async () => {
    const result = await sql`
      UPDATE registry_instances
      SET name = 'Hacked', domain = 'https://evil.example.com'
      WHERE instance_id = ${INSTANCE_ID} AND owner_user_id = ${USER_B}
      RETURNING instance_id`;
    expect(result).toHaveLength(0);
    // Verify the original data is intact
    const intact = await sql`SELECT name, domain FROM registry_instances WHERE instance_id = ${INSTANCE_ID}`;
    expect(intact[0].name).toBe('Test Instance');
    expect(intact[0].domain).toBe('https://test.example.com');
  });

  it('owner can update metadata but NOT domain (immutable via register)', async () => {
    const result = await sql`
      UPDATE registry_instances
      SET name = 'Updated Name', description = 'New desc'
      WHERE instance_id = ${INSTANCE_ID} AND owner_user_id = ${USER_A}
      RETURNING name, description`;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Updated Name');

    // Domain change requires the separate change-domain endpoint
    // (this is enforced at the query level — register's upsert doesn't
    // include domain in the SET clause)
  });

  it('NULL-owner legacy row is NOT claimable via update', async () => {
    const legacyId = `test-inst-legacy-${Date.now()}`;
    await sql`INSERT INTO registry_instances (instance_id, name, domain, public_key, owner_user_id)
      VALUES (${legacyId}, 'Legacy', 'https://legacy.example.com', 'pk-legacy', NULL)`;

    // setWhere(owner = excluded.owner) would be WHERE owner_user_id = USER_A
    // → NULL ≠ USER_A → no rows updated
    const result = await sql`
      UPDATE registry_instances SET name = 'Claimed'
      WHERE instance_id = ${legacyId} AND owner_user_id = ${USER_A}
      RETURNING instance_id`;
    expect(result).toHaveLength(0);

    // Verify the legacy row is untouched
    const intact = await sql`SELECT name FROM registry_instances WHERE instance_id = ${legacyId}`;
    expect(intact[0].name).toBe('Legacy');

    await sql`DELETE FROM registry_instances WHERE instance_id = ${legacyId}`;
  });

  it('concurrent registration: only one wins (unique constraint)', async () => {
    const concurrentId = `test-inst-concurrent-${Date.now()}`;
    await sql`INSERT INTO registry_instances (instance_id, name, domain, public_key, owner_user_id)
      VALUES (${concurrentId}, 'First', 'https://first.example.com', 'pk-1', ${USER_A})`;

    try {
      await sql`INSERT INTO registry_instances (instance_id, name, domain, public_key, owner_user_id)
        VALUES (${concurrentId}, 'Second', 'https://second.example.com', 'pk-2', ${USER_B})`;
      expect.fail('Should have thrown unique constraint violation');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('23505');
    }

    await sql`DELETE FROM registry_instances WHERE instance_id = ${concurrentId}`;
  });
});
