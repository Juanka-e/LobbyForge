/**
 * The profile card's queries (docs/PROFILES.md) against a recording fake
 * client — no Postgres needed. The real SQL runs in
 * member-profiles.integration.test.ts.
 *
 *  - getMemberProfileRecord: a CURRENT member only (live account, live
 *    server, no active ban), image references rather than images, every
 *    held role highest first with the legacy primary role folded in;
 *  - listMutualServers: both users members, a live server, neither banned,
 *    https icons only, and the total from the window count.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getMemberProfileRecord, listMutualServers } from '../queries/memberProfiles.js';

interface Step {
  op: string;
  args: unknown[];
}

function recordingDb(results: unknown[][]) {
  const chains: Step[][] = [];
  let next = 0;
  function start(op: string, args: unknown[]) {
    const steps: Step[] = [{ op, args }];
    chains.push(steps);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const value = results[next++] ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (...callArgs: unknown[]) => {
            steps.push({ op: String(prop), args: callArgs });
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { db: { select: (...args: unknown[]) => start('select', args) } as never, chains };
}

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

const SERVER = '00000000-0000-4000-8000-0000000000a1';
const VIEWER = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';

const baseRow = {
  membershipId: 'm-1',
  legacyRoleId: null as string | null,
  userId: MEMBER,
  globalDisplayName: 'Ayşe',
  nickname: null as string | null,
  avatarRef: '0123456789ab',
  bannerRef: null,
  profileVisibility: null,
  isGuest: false,
  statusText: 'Gaming',
  bio: 'Hello',
  accountCreatedAt: new Date('2025-01-02T03:04:05Z'),
  joinedAt: new Date('2026-02-03T04:05:06Z'),
  timedOutUntil: null,
  voiceMuted: false,
};

describe('getMemberProfileRecord', () => {
  it('null for anyone who is not a current member — and the roles are not read', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await getMemberProfileRecord(db, SERVER, MEMBER)).toBeNull();
    expect(chains).toHaveLength(1);
    const where = render(chains[0]!.find((s) => s.op === 'where')!.args[0]);
    // Live account, live server, no active ban on the membership.
    expect(where.sql).toContain('"users"."deleted_at" is null');
    expect(where.sql).toContain('"servers"."deleted_at" is null');
    expect(where.sql).toMatch(/not exists \(\s*select 1 from "server_bans"/);
    expect(where.sql).toContain('"server_bans"."expires_at" is null or "server_bans"."expires_at" > now()');
    expect(where.params).toEqual([SERVER, MEMBER]);
  });

  it('selects image references, never the image columns themselves', async () => {
    const { db, chains } = recordingDb([[baseRow], []]);
    await getMemberProfileRecord(db, SERVER, MEMBER);
    const fields = chains[0]![0]!.args[0] as Record<string, unknown>;
    expect(render(fields.avatarRef).sql).toContain('substr(md5(');
    expect(render(fields.bannerRef).sql).toContain('substr(md5(');
    // The visibility subquery reads the SUBJECT's settings, qualified.
    expect(render(fields.profileVisibility).sql).toContain('"user_settings"."user_id" = "users"."id"');
  });

  it('every held role, highest first, with the legacy primary role folded in once', async () => {
    const { db, chains } = recordingDb([
      [{ ...baseRow, legacyRoleId: 'r-legacy', nickname: '  ' }],
      [
        { id: 'r-everyone', name: '@everyone', color: null, icon: null, position: 0, permissions: ['send_messages'] },
        { id: 'r-mod', name: 'Mods', color: '#ff0000', icon: 'shield', position: 10, displaySeparately: true, permissions: ['kick_members', 42] },
      ],
      [{ id: 'r-legacy', name: 'Veteran', color: '#00ff00', icon: null, position: 5, permissions: null }],
    ]);
    const record = await getMemberProfileRecord(db, SERVER, MEMBER);
    expect(chains).toHaveLength(3);
    expect(record).toMatchObject({
      userId: MEMBER,
      globalDisplayName: 'Ayşe',
      // A blank nickname is no nickname.
      nickname: null,
      profileVisibility: 'server_members',
      joinedAt: baseRow.joinedAt,
      accountCreatedAt: baseRow.accountCreatedAt,
    });
    expect(record!.roles.map((r) => r.id)).toEqual(['r-mod', 'r-legacy', 'r-everyone']);
    // Malformed permission entries are dropped.
    expect(record!.roles[0]!.permissions).toEqual(['kick_members']);
    expect(record!.roles[1]!.permissions).toEqual([]);
    // Whether a role gets its own heading in the member list (the lobby
    // regroups a member after a role change made in the card).
    expect(record!.roles.map((r) => r.displaySeparately)).toEqual([true, false, false]);
    // Both role reads stay inside this server.
    expect(render(chains[1]!.find((s) => s.op === 'where')!.args[0]).params).toEqual(['m-1', SERVER]);
    expect(render(chains[2]!.find((s) => s.op === 'where')!.args[0]).params).toEqual(['r-legacy', SERVER]);
  });

  it('does not read the legacy role again when the join table already has it', async () => {
    const { db, chains } = recordingDb([
      [{ ...baseRow, legacyRoleId: 'r-mod', nickname: 'Ace' }],
      [{ id: 'r-mod', name: 'Mods', color: null, icon: null, position: 10, permissions: [] }],
    ]);
    const record = await getMemberProfileRecord(db, SERVER, MEMBER);
    expect(chains).toHaveLength(2);
    expect(record!.nickname).toBe('Ace');
  });
});

describe('listMutualServers', () => {
  it('both members of a live server, neither banned, with both ids as parameters', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await listMutualServers(db, VIEWER, MEMBER)).toEqual({ servers: [], total: 0 });
    const chain = chains[0]!;
    const join = chain.find((s) => s.op === 'innerJoin')!;
    expect(render(join.args[1]).params).toEqual([VIEWER]);
    const where = render(chain.find((s) => s.op === 'where')!.args[0]);
    expect(where.sql).toContain('"servers"."deleted_at" is null');
    // The viewer's own ban (on the joined membership) …
    expect(where.sql).toMatch(/not exists \(\s*select 1 from "server_bans"/);
    // … the subject's membership on a live account, and the subject's ban.
    expect(where.sql).toContain('subject_m.server_id = "servers"."id"');
    expect(where.sql).toContain('subject_u.deleted_at is null');
    expect(where.sql).toContain('subject_b.server_id = "servers"."id"');
    expect(where.sql).toContain('subject_b.expires_at is null or subject_b.expires_at > now()');
    expect(where.params).toEqual([MEMBER, MEMBER]);
    expect(chain.find((s) => s.op === 'limit')!.args[0]).toBe(50);
  });

  it('an icon only when it is a bounded https URL — never a data URL', async () => {
    const { db, chains } = recordingDb([[]]);
    await listMutualServers(db, VIEWER, MEMBER);
    const fields = chains[0]![0]!.args[0] as Record<string, unknown>;
    const icon = render(fields.iconUrl).sql;
    expect(icon).toContain("substr(\"servers\".\"icon_url\", 1, 8) = 'https://'");
    expect(icon).toContain('octet_length("servers"."icon_url") <= 2048');
    expect(render(fields.total).sql).toBe('count(*) over ()');
  });

  it('reads the total from the window count and clamps the limit', async () => {
    const { db, chains } = recordingDb([
      [
        { id: 's-1', name: 'Alpha', iconUrl: null, total: '7' },
        { id: 's-2', name: 'Beta', iconUrl: 'https://cdn.example/b.png', total: '7' },
      ],
    ]);
    const result = await listMutualServers(db, VIEWER, MEMBER, { limit: 500 });
    expect(result).toEqual({
      servers: [
        { id: 's-1', name: 'Alpha', iconUrl: null },
        { id: 's-2', name: 'Beta', iconUrl: 'https://cdn.example/b.png' },
      ],
      total: 7,
    });
    expect(chains[0]!.find((s) => s.op === 'limit')!.args[0]).toBe(100);
  });
});
