import { describe, expect, it } from 'vitest';
import {
  CHAT_POLL_DURATIONS_HOURS,
  CreateChatPollSchema,
  applyChatPollUpdate,
  asChatPollUpdate,
  asChatPollView,
  catchUpChatPoll,
  checkChatPollDraft,
  checkVoteChoices,
  isPollChannelType,
  pollOptionKey,
  pollSharePercent,
  pollTimeLeft,
  projectChatPoll,
  readMessagePollId,
  toChatPollUpdate,
  type ChatPollSource,
} from '../chat-polls';

/** Polls in text channels (docs/CHAT_POLLS.md): the pure rules. */

const NOW = new Date('2026-10-10T12:00:00Z');
const HOUR = 60 * 60_000;

function source(overrides: Partial<ChatPollSource> = {}): ChatPollSource {
  return {
    id: 'poll-1',
    messageId: 'msg-1',
    question: 'Pizza?',
    options: ['Yes', 'No', 'Maybe'],
    allowMultiple: false,
    closesAt: new Date(NOW.getTime() + HOUR),
    closedAt: null,
    counts: [3, 1, 0],
    totalVoters: 4,
    viewerChoices: [],
    version: 3,
    ...overrides,
  };
}

describe('pollOptionKey', () => {
  it('ignores case, outer and repeated inner spaces, and the dotted İ', () => {
    expect(pollOptionKey('  Pizza   Night ')).toBe(pollOptionKey('pizza night'));
    expect(pollOptionKey('PIZZA')).toBe('pizza');
    expect(pollOptionKey('İstanbul')).toBe(pollOptionKey('istanbul'));
    expect(pollOptionKey('Pizza')).not.toBe(pollOptionKey('Pizzas'));
  });
});

describe('checkChatPollDraft', () => {
  it('accepts a question and two answers, trimming both and skipping blank rows', () => {
    const check = checkChatPollDraft('  Pizza?  ', [' Yes ', '', 'No']);
    expect(check).toMatchObject({ ok: true, question: 'Pizza?', options: ['Yes', 'No'], optionProblems: [null, null, null] });
  });

  it('names each problem', () => {
    expect(checkChatPollDraft('', ['a', 'b']).questionProblem).toBe('required');
    expect(checkChatPollDraft('q'.repeat(301), ['a', 'b']).questionProblem).toBe('tooLong');
    expect(checkChatPollDraft('q'.repeat(300), ['a', 'b']).ok).toBe(true);
    expect(checkChatPollDraft('Q', ['only', '  ']).optionsProblem).toBe('tooFew');
    expect(checkChatPollDraft('Q', Array.from({ length: 11 }, (_, i) => `o${i}`)).optionsProblem).toBe('tooMany');
    expect(checkChatPollDraft('Q', ['a', 'b'.repeat(81)]).optionProblems).toEqual([null, 'tooLong']);
    const dup = checkChatPollDraft('Q', ['Pizza', 'Tacos', ' pizza ']);
    expect(dup.optionProblems).toEqual([null, null, 'duplicate']);
    expect(dup.ok).toBe(false);
  });
});

describe('CreateChatPollSchema (the create route body)', () => {
  it('defaults to single choice for 24 hours and trims', () => {
    const parsed = CreateChatPollSchema.parse({ question: ' Q ', options: [' a ', 'b'] });
    expect(parsed).toEqual({ question: 'Q', options: ['a', 'b'], allowMultiple: false, durationHours: 24 });
  });

  it('takes only the offered durations', () => {
    for (const hours of CHAT_POLL_DURATIONS_HOURS) {
      expect(CreateChatPollSchema.safeParse({ question: 'Q', options: ['a', 'b'], durationHours: hours }).success).toBe(true);
    }
    expect(CHAT_POLL_DURATIONS_HOURS).toEqual([1, 4, 8, 24, 72, 168]);
    for (const hours of [0, 2, 25, 169, -1, 1.5]) {
      expect(CreateChatPollSchema.safeParse({ question: 'Q', options: ['a', 'b'], durationHours: hours }).success).toBe(false);
    }
  });

  it('refuses blank or duplicate options, too many or too few, and unknown fields', () => {
    const bad = [
      { question: 'Q', options: ['a', ' '] },
      { question: 'Q', options: ['a', 'A'] },
      { question: 'Q', options: ['a'] },
      { question: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) },
      { question: '', options: ['a', 'b'] },
      { question: 'Q', options: ['a', 'b'], creatorUserId: 'x' },
    ];
    for (const body of bad) expect(CreateChatPollSchema.safeParse(body).success).toBe(false);
  });
});

describe('checkVoteChoices', () => {
  it('single choice: exactly one option on the poll', () => {
    const poll = { optionCount: 3, allowMultiple: false };
    expect(checkVoteChoices([2], poll)).toBeNull();
    expect(checkVoteChoices([0, 1], poll)).toBe('single_choice');
    expect(checkVoteChoices([3], poll)).toBe('out_of_range');
    expect(checkVoteChoices([-1], poll)).toBe('out_of_range');
  });

  it('multiple choice: up to every option, each once', () => {
    const poll = { optionCount: 3, allowMultiple: true };
    expect(checkVoteChoices([0, 2], poll)).toBeNull();
    expect(checkVoteChoices([0, 1, 2], poll)).toBeNull();
    expect(checkVoteChoices([1, 1], poll)).toBe('duplicate');
    expect(checkVoteChoices([0, 1.5], poll)).toBe('out_of_range');
  });
});

describe('projectChatPoll — what a viewer may see', () => {
  it('hides the counts from a viewer who has not voted on an open poll, but shows the voter total', () => {
    const view = projectChatPoll(source(), NOW);
    expect(view).toMatchObject({ resultsVisible: false, closed: false, totalVoters: 4, myChoices: [] });
    expect(view.options).toEqual([
      { text: 'Yes', votes: null },
      { text: 'No', votes: null },
      { text: 'Maybe', votes: null },
    ]);
  });

  it('shows the counts after voting, and to everyone once closed (by time or early)', () => {
    expect(projectChatPoll(source({ viewerChoices: [1] }), NOW)).toMatchObject({ resultsVisible: true, myChoices: [1], options: [{ votes: 3 }, { votes: 1 }, { votes: 0 }] });
    expect(projectChatPoll(source({ closesAt: new Date(NOW.getTime() - 1) }), NOW)).toMatchObject({ closed: true, resultsVisible: true });
    expect(projectChatPoll(source({ closedAt: new Date(NOW.getTime() - HOUR) }), NOW)).toMatchObject({ closed: true, resultsVisible: true });
  });

  it('carries only its own fields — nothing extra a source might hold leaks through', () => {
    const leaky = { ...source(), ballots: [{ userId: 'u-secret', optionIndex: 0 }], creatorUserId: 'u-creator' } as ChatPollSource;
    const view = projectChatPoll(leaky, NOW);
    expect(JSON.stringify(view)).not.toMatch(/u-secret|u-creator/);
    const update = toChatPollUpdate(leaky, NOW);
    expect(JSON.stringify(update)).not.toMatch(/u-secret|u-creator/);
    expect(update).toEqual({
      id: 'poll-1',
      messageId: 'msg-1',
      counts: [3, 1, 0],
      totalVoters: 4,
      closesAt: new Date(NOW.getTime() + HOUR).toISOString(),
      closedAt: null,
      closed: false,
      version: 3,
    });
  });
});

describe('applyChatPollUpdate — a realtime update', () => {
  const update = (overrides = {}) => ({ ...toChatPollUpdate(source({ counts: [5, 2, 1], totalVoters: 7 }), NOW), ...overrides });

  it('moves only the voter total for a viewer who has not voted', () => {
    const next = applyChatPollUpdate(projectChatPoll(source(), NOW), update(), NOW);
    expect(next.totalVoters).toBe(7);
    expect(next.options.map((o) => o.votes)).toEqual([null, null, null]);
    expect(next.resultsVisible).toBe(false);
  });

  it('moves the counts for a voter, and for everyone once the poll is closed', () => {
    const voted = applyChatPollUpdate(projectChatPoll(source({ viewerChoices: [0] }), NOW), update(), NOW);
    expect(voted.options.map((o) => o.votes)).toEqual([5, 2, 1]);
    expect(voted.myChoices).toEqual([0]);
    const closed = applyChatPollUpdate(projectChatPoll(source(), NOW), update({ closed: true, closedAt: NOW.toISOString() }), NOW);
    expect(closed).toMatchObject({ closed: true, resultsVisible: true });
    expect(closed.options.map((o) => o.votes)).toEqual([5, 2, 1]);
  });

  it('ignores an update for another poll', () => {
    const view = projectChatPoll(source(), NOW);
    expect(applyChatPollUpdate(view, update({ id: 'poll-2' }), NOW)).toBe(view);
  });

  it('drops an update older than what is shown (they can arrive out of order)', () => {
    const view = projectChatPoll(source({ viewerChoices: [0], counts: [5, 2, 1], version: 9 }), NOW);
    const stale = update({ counts: [1, 0, 0], totalVoters: 1, version: 8 });
    expect(applyChatPollUpdate(view, stale, NOW)).toBe(view);
    const next = applyChatPollUpdate(view, update({ counts: [6, 2, 1], totalVoters: 9, version: 10 }), NOW);
    expect(next.version).toBe(10);
    expect(next.options.map((o) => o.votes)).toEqual([6, 2, 1]);
  });

  it('never reopens a closed poll, whatever arrives after the close', () => {
    const closedView = applyChatPollUpdate(
      projectChatPoll(source(), NOW),
      update({ closed: true, closedAt: NOW.toISOString(), version: 5 }),
      NOW
    );
    expect(closedView.closed).toBe(true);
    // Same version (the same snapshot again) without the close: still closed.
    const replay = applyChatPollUpdate(closedView, update({ closed: false, closedAt: null, version: 5 }), NOW);
    expect(replay).toMatchObject({ closed: true, closedAt: NOW.toISOString(), resultsVisible: true });
  });

  it('catchUpChatPoll brings an older REST view up to the newest update, keeping the answer’s own choices', () => {
    const fromRest = projectChatPoll(source({ viewerChoices: [1], counts: [3, 1, 0], version: 4 }), NOW);
    const caughtUp = catchUpChatPoll(fromRest, update({ counts: [3, 2, 1], totalVoters: 6, version: 6 }), NOW);
    expect(caughtUp).toMatchObject({ version: 6, totalVoters: 6, myChoices: [1] });
    expect(caughtUp.options.map((o) => o.votes)).toEqual([3, 2, 1]);
    expect(catchUpChatPoll(fromRest, update({ version: 4 }), NOW)).toBe(fromRest);
    expect(catchUpChatPoll(fromRest, undefined, NOW)).toBe(fromRest);
  });
});

describe('payload readers', () => {
  it('read a view and an update, and refuse anything malformed', () => {
    const view = projectChatPoll(source({ viewerChoices: [2] }), NOW);
    expect(asChatPollView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(asChatPollView(null)).toBeNull();
    expect(asChatPollView({ id: 'x' })).toBeNull();
    const update = toChatPollUpdate(source(), NOW);
    expect(asChatPollUpdate(JSON.parse(JSON.stringify(update)))).toEqual(update);
    expect(asChatPollUpdate({ id: 'x', messageId: 'y' })).toBeNull();
  });

  it('readMessagePollId finds metadata.poll.id only', () => {
    expect(readMessagePollId({ poll: { id: 'p' } })).toBe('p');
    expect(readMessagePollId({ poll: 'p' })).toBeNull();
    expect(readMessagePollId({})).toBeNull();
    expect(readMessagePollId(null)).toBeNull();
  });

  it('only text and announcement channels take polls', () => {
    expect(isPollChannelType('text')).toBe(true);
    expect(isPollChannelType('announcement')).toBe(true);
    for (const type of ['voice', 'stage', 'activity', null, undefined]) expect(isPollChannelType(type)).toBe(false);
  });
});

describe('pollSharePercent and pollTimeLeft', () => {
  it('rounds shares and never divides by zero', () => {
    expect(pollSharePercent(1, 3)).toBe(33);
    expect(pollSharePercent(2, 3)).toBe(67);
    expect(pollSharePercent(0, 0)).toBe(0);
  });

  it('counts down in minutes, hours, then days', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(pollTimeLeft(at(30_000), false, NOW)).toEqual({ unit: 'lessThanMinute' });
    expect(pollTimeLeft(at(59 * 60_000), false, NOW)).toEqual({ unit: 'minutes', count: 59 });
    expect(pollTimeLeft(at(HOUR), false, NOW)).toEqual({ unit: 'hours', count: 1 });
    expect(pollTimeLeft(at(2.5 * HOUR), false, NOW)).toEqual({ unit: 'hours', count: 3 });
    expect(pollTimeLeft(at(24 * HOUR), false, NOW)).toEqual({ unit: 'hours', count: 24 });
    expect(pollTimeLeft(at(72 * HOUR), false, NOW)).toEqual({ unit: 'days', count: 3 });
    expect(pollTimeLeft(at(-1), false, NOW)).toEqual({ unit: 'closed' });
    expect(pollTimeLeft(at(HOUR), true, NOW)).toEqual({ unit: 'closed' });
  });
});
