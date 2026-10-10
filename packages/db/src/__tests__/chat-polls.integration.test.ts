/**
 * Polls in text channels (0047) against real Postgres:
 *   - the message and its poll are written together, and the message
 *     names the poll in `metadata.poll.id`;
 *   - one batched read returns each poll's counts, its number of voters
 *     and ONLY the viewer's own choices;
 *   - a vote replaces the previous one, can be removed, and is refused
 *     once the poll has expired or was closed early; concurrent votes by
 *     one member never leave two rows on a single-choice poll;
 *   - deleting the message (hard: FK cascade; soft: the route's explicit
 *     delete) removes the poll and every ballot;
 *   - the role backfill grants `create_polls` to admin and moderator-style
 *     roles only.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  clearMessagePollVote,
  closeMessagePoll,
  createMessagePoll,
  deleteMessagePollForMessage,
  getMessagePollById,
  getMessagePollWithTally,
  listMessagePollsForMessages,
  setMessagePollVote,
} from '../queries/messagePolls.js';
import { softDeleteMessage } from '../queries/messages.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60_000;

describe.skipIf(!DB_URL)('chat polls (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 4 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const ada = randomUUID();
  const bora = randomUUID();
  const cem = randomUUID();
  const serverId = randomUUID();
  const channelId = randomUUID();

  beforeAll(async () => {
    await sql`
      INSERT INTO users (id, display_name) VALUES
        (${owner}, 'Owner'), (${ada}, 'Ada'), (${bora}, 'Bora'), (${cem}, 'Cem')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'PollTest', ${owner})`;
    await sql`INSERT INTO channels (id, server_id, name, type) VALUES (${channelId}, ${serverId}, 'general', 'text')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${ada}, ${bora}, ${cem})`;
    await sql.end();
  });

  async function newPoll(opts: { allowMultiple?: boolean; closesAt?: Date } = {}) {
    return createMessagePoll(db, {
      channelId,
      userId: owner,
      question: 'What should we play?',
      options: ['Hushle', 'Quiz', 'Vampire Village'],
      allowMultiple: opts.allowMultiple ?? false,
      closesAt: opts.closesAt ?? new Date(Date.now() + 24 * HOUR),
    });
  }

  it('writes the message and its poll together', async () => {
    const { message, poll } = await newPoll();
    expect(message.content).toBe('What should we play?');
    expect(message.metadata).toEqual({ poll: { id: poll.id } });
    expect(poll.messageId).toBe(message.id);
    expect(poll.options).toEqual(['Hushle', 'Quiz', 'Vampire Village']);
    expect((await getMessagePollById(db, poll.id))?.question).toBe('What should we play?');
  });

  it('refuses a deleted server’s channel without leaving a message behind', async () => {
    const deadServer = randomUUID();
    const deadChannel = randomUUID();
    await sql`INSERT INTO servers (id, name, owner_user_id, deleted_at) VALUES (${deadServer}, 'Gone', ${owner}, now())`;
    await sql`INSERT INTO channels (id, server_id, name, type) VALUES (${deadChannel}, ${deadServer}, 'general', 'text')`;
    try {
      await expect(
        createMessagePoll(db, { channelId: deadChannel, userId: owner, question: 'Q', options: ['a', 'b'], allowMultiple: false, closesAt: new Date(Date.now() + HOUR) })
      ).rejects.toThrow(/does not exist/);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE channel_id = ${deadChannel}`;
      expect(n).toBe(0);
    } finally {
      await sql`DELETE FROM servers WHERE id = ${deadServer}`;
    }
  });

  it('counts votes, counts each voter once, and returns only the viewer’s own choices', async () => {
    const single = await newPoll();
    const multi = await newPoll({ allowMultiple: true });
    expect(await setMessagePollVote(db, { pollId: single.poll.id, userId: ada, optionIndexes: [0] })).toEqual({ ok: true });
    expect(await setMessagePollVote(db, { pollId: single.poll.id, userId: bora, optionIndexes: [2] })).toEqual({ ok: true });
    expect(await setMessagePollVote(db, { pollId: single.poll.id, userId: cem, optionIndexes: [2] })).toEqual({ ok: true });
    expect(await setMessagePollVote(db, { pollId: multi.poll.id, userId: ada, optionIndexes: [0, 1, 1] })).toEqual({ ok: true });

    const page = await listMessagePollsForMessages(db, [single.message.id, multi.message.id, randomUUID()], bora);
    expect(page.size).toBe(2);
    const s = page.get(single.message.id)!;
    expect(s.counts).toEqual([1, 0, 2]);
    expect(s.totalVoters).toBe(3);
    expect(s.viewerChoices).toEqual([2]);
    const m = page.get(multi.message.id)!;
    expect(m.counts).toEqual([1, 1, 0]);
    expect(m.totalVoters).toBe(1);
    expect(m.viewerChoices).toEqual([]);

    // Nothing in the read names another voter.
    expect(JSON.stringify(Object.fromEntries(page))).not.toContain(ada);
    expect(JSON.stringify(Object.fromEntries(page))).not.toContain(cem);

    // A viewer with no account sees counts and no choices.
    const anon = await getMessagePollWithTally(db, single.poll.id, null);
    expect(anon?.viewerChoices).toEqual([]);
    expect(anon?.counts).toEqual([1, 0, 2]);
  });

  it('replaces a vote, removes it, and refuses both once the poll has closed', async () => {
    const { poll } = await newPoll();
    await setMessagePollVote(db, { pollId: poll.id, userId: ada, optionIndexes: [0] });
    await setMessagePollVote(db, { pollId: poll.id, userId: ada, optionIndexes: [1] });
    let tally = await getMessagePollWithTally(db, poll.id, ada);
    expect(tally?.counts).toEqual([0, 1, 0]);
    expect(tally?.viewerChoices).toEqual([1]);

    expect(await clearMessagePollVote(db, { pollId: poll.id, userId: ada })).toEqual({ ok: true });
    tally = await getMessagePollWithTally(db, poll.id, ada);
    expect(tally?.totalVoters).toBe(0);
    expect(tally?.viewerChoices).toEqual([]);

    await setMessagePollVote(db, { pollId: poll.id, userId: ada, optionIndexes: [2] });
    const closed = await closeMessagePoll(db, { pollId: poll.id, userId: owner });
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.poll.closedByUserId).toBe(owner);
    expect(await setMessagePollVote(db, { pollId: poll.id, userId: bora, optionIndexes: [0] })).toEqual({ ok: false, reason: 'closed' });
    expect(await clearMessagePollVote(db, { pollId: poll.id, userId: ada })).toEqual({ ok: false, reason: 'closed' });
    expect(await closeMessagePoll(db, { pollId: poll.id, userId: owner })).toEqual({ ok: false, reason: 'closed' });
    // The final result stays.
    expect((await getMessagePollWithTally(db, poll.id, bora))?.counts).toEqual([0, 0, 1]);
  });

  it('closes lazily at closes_at — no job needed', async () => {
    const { poll } = await newPoll({ closesAt: new Date(Date.now() + HOUR) });
    const later = new Date(Date.now() + 2 * HOUR);
    expect(await setMessagePollVote(db, { pollId: poll.id, userId: ada, optionIndexes: [0], now: later })).toEqual({ ok: false, reason: 'closed' });
    expect(await closeMessagePoll(db, { pollId: poll.id, userId: owner, now: later })).toEqual({ ok: false, reason: 'closed' });
    expect(await setMessagePollVote(db, { pollId: poll.id, userId: ada, optionIndexes: [0] })).toEqual({ ok: true });
  });

  it('never leaves two rows on a single-choice poll when one member votes twice at once', async () => {
    const { poll } = await newPoll();
    await Promise.all(
      [0, 1, 2, 0, 1, 2].map((option) => setMessagePollVote(db, { pollId: poll.id, userId: cem, optionIndexes: [option] }))
    );
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM message_poll_votes WHERE poll_id = ${poll.id} AND user_id = ${cem}`;
    expect(rows[0]!.n).toBe(1);
  });

  it('answers not_found for an unknown poll', async () => {
    const unknown = randomUUID();
    expect(await setMessagePollVote(db, { pollId: unknown, userId: ada, optionIndexes: [0] })).toEqual({ ok: false, reason: 'not_found' });
    expect(await closeMessagePoll(db, { pollId: unknown, userId: owner })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a deleted message takes its poll and every ballot with it', async () => {
    // Soft delete (the messages DELETE route): hidden at once, then removed.
    const soft = await newPoll();
    await setMessagePollVote(db, { pollId: soft.poll.id, userId: ada, optionIndexes: [1] });
    await softDeleteMessage(db, soft.message.id);
    expect(await getMessagePollById(db, soft.poll.id)).toBeNull();
    expect((await listMessagePollsForMessages(db, [soft.message.id], ada)).size).toBe(0);
    expect(await setMessagePollVote(db, { pollId: soft.poll.id, userId: bora, optionIndexes: [0] })).toEqual({ ok: false, reason: 'not_found' });
    expect(await deleteMessagePollForMessage(db, soft.message.id)).toBe(true);
    expect(await deleteMessagePollForMessage(db, soft.message.id)).toBe(false);

    // Hard delete (channel removal, retention): the FK cascade.
    const hard = await newPoll();
    await setMessagePollVote(db, { pollId: hard.poll.id, userId: ada, optionIndexes: [0] });
    await sql`DELETE FROM messages WHERE id = ${hard.message.id}`;

    for (const id of [soft.poll.id, hard.poll.id]) {
      const polls = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM message_polls WHERE id = ${id}`;
      const votes = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM message_poll_votes WHERE poll_id = ${id}`;
      expect(polls[0]!.n).toBe(0);
      expect(votes[0]!.n).toBe(0);
    }
  });

  it('the backfill grants create_polls to admin and moderator-style roles only, once', async () => {
    const backfill = readFileSync(join(__dirname, '..', '..', 'drizzle', '0047_chat_polls.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .find((statement) => statement.startsWith('UPDATE'))!
      // Scoped to this suite's server so a shared scratch database is left alone.
      .replace(/;\s*$/, ` AND "server_id" = '${serverId}';`);
    const ids = { everyone: randomUUID(), admin: randomUUID(), mod: randomUUID(), member: randomUUID(), modEveryone: randomUUID() };
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions) VALUES
        (${ids.everyone}, ${serverId}, '@everyone', 0, '["send_messages"]'::jsonb),
        (${ids.modEveryone}, ${serverId}, '@everyone', 1, '["manage_messages"]'::jsonb),
        (${ids.admin}, ${serverId}, 'Owner', 100, '["administrator","manage_server"]'::jsonb),
        (${ids.mod}, ${serverId}, 'Mods', 50, '["manage_messages","kick_members"]'::jsonb),
        (${ids.member}, ${serverId}, 'Regulars', 10, '["send_messages","stream"]'::jsonb)`;
    await sql.unsafe(backfill);
    await sql.unsafe(backfill);
    const rows = await sql<{ id: string; permissions: string[] }[]>`SELECT id, permissions FROM roles WHERE server_id = ${serverId}`;
    const perms = new Map(rows.map((r) => [r.id, r.permissions]));
    expect(perms.get(ids.admin)).toEqual(['administrator', 'manage_server', 'create_polls']);
    expect(perms.get(ids.mod)).toEqual(['manage_messages', 'kick_members', 'create_polls']);
    expect(perms.get(ids.member)).toEqual(['send_messages', 'stream']);
    expect(perms.get(ids.everyone)).toEqual(['send_messages']);
    expect(perms.get(ids.modEveryone)).toEqual(['manage_messages']);
  });
});
