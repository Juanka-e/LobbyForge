/**
 * beta-review: unit tests for two query-level fixes, run against a
 * capturing fake client (no Postgres needed).
 *   - S10: changeRegistryInstanceDomain resets isVerified/isListed.
 *   - activity end race: setGameSessionStateCAS refuses terminal sessions
 *     (status is part of the CAS WHERE).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { changeRegistryInstanceDomain } from '../queries/registryInstances.js';
import { setGameSessionStateCAS } from '../queries/gameSessions.js';

interface Captured {
  patch?: Record<string, unknown>;
  where?: SQL;
}

/** Minimal update().set().where().returning() chain that records its inputs. */
function fakeDb(captured: Captured, returning: unknown[], selectRows: unknown[] = []) {
  const chain = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        captured.patch = patch;
        return {
          where: (where: SQL) => {
            captured.where = where;
            return { returning: async () => returning };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectRows }),
      }),
    }),
  };
  return chain as never;
}

function renderWhere(where: SQL | undefined): string {
  if (!where) throw new Error('no WHERE captured');
  return new PgDialect().sqlToQuery(where).sql;
}

describe('changeRegistryInstanceDomain — beta-review S10', () => {
  it('moves the domain AND sends the entry back through review', async () => {
    const captured: Captured = {};
    const ok = await changeRegistryInstanceDomain(fakeDb(captured, [{ id: 'row-1' }]), {
      instanceId: 'inst-1',
      ownerUserId: 'owner-1',
      newDomain: 'https://new.example.com',
    });
    expect(ok).toBe(true);
    expect(captured.patch).toEqual({
      domain: 'https://new.example.com',
      isVerified: false,
      isListed: false,
    });
    // Still owner-scoped.
    expect(renderWhere(captured.where)).toContain('"owner_user_id"');
  });

  it('returns false when no owned row matched', async () => {
    const captured: Captured = {};
    const ok = await changeRegistryInstanceDomain(fakeDb(captured, []), {
      instanceId: 'inst-1',
      ownerUserId: 'intruder',
      newDomain: 'https://new.example.com',
    });
    expect(ok).toBe(false);
  });
});

describe('setGameSessionStateCAS — beta-review terminal-session guard', () => {
  it('includes the session status in the CAS WHERE', async () => {
    const captured: Captured = {};
    await setGameSessionStateCAS(fakeDb(captured, [{ id: 's-1', status: 'running' }]), 's-1', 3, { a: 1 });
    const where = renderWhere(captured.where);
    expect(where).toContain('"revision"');
    expect(where).toContain(`"status" not in ('ended', 'cancelled')`);
  });

  it('reports ok:false with the current (ended) row when the guard refuses', async () => {
    const captured: Captured = {};
    const ended = { id: 's-1', status: 'ended', revision: 3 };
    const result = await setGameSessionStateCAS(fakeDb(captured, [], [ended]), 's-1', 3, { a: 1 });
    expect(result).toEqual({ ok: false, row: ended });
  });
});
