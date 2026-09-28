import { describe, expect, it, vi } from 'vitest';

vi.mock('@lobbyforge/db', () => ({
  users: { id: 'users.id', email: 'users.email', displayName: 'users.displayName' },
}));

const { createOfficialAccount } = await import('../official-account');

/** A Drizzle insert chain that records what it was asked to write. */
function fakeDb(returned: Array<{ id: string; email: string | null; displayName: string }>) {
  const calls: { table?: unknown; values?: Record<string, unknown>; conflict?: unknown; returning?: unknown } = {};
  const db = {
    insert(table: unknown) {
      calls.table = table;
      return {
        values(values: Record<string, unknown>) {
          calls.values = values;
          return {
            onConflictDoNothing(conflict: unknown) {
              calls.conflict = conflict;
              return {
                returning: async (selection: unknown) => {
                  calls.returning = selection;
                  return returned;
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as never, calls };
}

describe('createOfficialAccount', () => {
  it('creates a password account that belongs to no community yet', async () => {
    const { db, calls } = fakeDb([{ id: 'u1', email: 'ada@example.com', displayName: 'Ada' }]);
    const result = await createOfficialAccount(db, {
      email: '  Ada@Example.com ',
      displayName: '  Ada ',
      passwordHash: 'scrypt$hash',
    });
    expect(result).toEqual({ ok: true, user: { id: 'u1', email: 'ada@example.com', displayName: 'Ada' } });
    expect(calls.values).toEqual({
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: 'scrypt$hash',
      isGuest: false,
    });
    // Idempotent on the unique email — no second account for one address.
    expect(calls.conflict).toEqual({ target: 'users.email' });
  });

  it('reports an address that already has an account', async () => {
    const { db } = fakeDb([]);
    await expect(
      createOfficialAccount(db, { email: 'ada@example.com', displayName: 'Ada', passwordHash: 'h' })
    ).resolves.toEqual({ ok: false, error: 'email_exists' });
  });
});
