import { describe, expect, it } from 'vitest';
import { POLL_MAX_OPTION_LENGTH, POLL_MAX_OPTIONS, POLL_MAX_QUESTION_LENGTH, pollValidateAction } from '../index';
import {
  checkDraft,
  pollPhaseOf,
  resultsVisible,
  sharePercent,
  showTurnout,
  totalVotes,
  voteStorageKey,
} from '../view';

describe('poll panel — when results show', () => {
  it('keeps the tally hidden until the viewer has voted', () => {
    expect(resultsVisible('open', false)).toBe(false);
    expect(resultsVisible('open', true)).toBe(true);
  });

  it('shows the final tally to everyone once the poll closes', () => {
    expect(resultsVisible('closed', false)).toBe(true);
    expect(resultsVisible('closed', true)).toBe(true);
  });

  it('has nothing to show before a poll exists', () => {
    expect(resultsVisible('idle', false)).toBe(false);
  });

  it('reads an unknown or missing phase as "no poll yet"', () => {
    expect(pollPhaseOf('open')).toBe('open');
    expect(pollPhaseOf('closed')).toBe('closed');
    expect(pollPhaseOf('idle')).toBe('idle');
    expect(pollPhaseOf(undefined)).toBe('idle');
    expect(pollPhaseOf('playing')).toBe('idle');
  });
});

describe('poll panel — reading a result', () => {
  const options = [
    { id: 'opt-1', text: 'Hushle', votes: 2 },
    { id: 'opt-2', text: 'Quiz', votes: 1 },
    { id: 'opt-3', text: 'Watch Party', votes: 0 },
  ];

  it('counts votes, tolerating a malformed count', () => {
    expect(totalVotes(options)).toBe(3);
    expect(totalVotes([{ id: 'x', text: 'x', votes: Number.NaN }])).toBe(0);
  });

  it('rounds each share to a whole percentage, and never divides by zero', () => {
    expect(sharePercent(2, 3)).toBe(67);
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(0, 3)).toBe(0);
    expect(sharePercent(0, 0)).toBe(0);
  });

  it('only claims "x of y players voted" when y is a real denominator', () => {
    expect(showTurnout(5, 3)).toBe(true);
    // The session registers only its creator, so ballots routinely
    // outnumber "players" — never print "3 of 1".
    expect(showTurnout(1, 3)).toBe(false);
    expect(showTurnout(2, 3)).toBe(false);
    expect(showTurnout(0, 0)).toBe(false);
  });
});

describe('poll panel — checking a draft before it opens', () => {
  it('sends a trimmed question and only the filled-in options', () => {
    const check = checkDraft('  Next game?  ', [' Hushle ', '', 'Quiz', '   ']);
    expect(check).toMatchObject({
      ok: true,
      question: 'Next game?',
      options: ['Hushle', 'Quiz'],
      questionProblem: null,
      optionsProblem: null,
    });
  });

  it('asks for a question first', () => {
    expect(checkDraft('   ', ['Hushle', 'Quiz'])).toMatchObject({ ok: false, questionProblem: 'questionRequired' });
  });

  it('needs at least two filled-in options, and points at the first empty row', () => {
    expect(checkDraft('Next?', ['Hushle', ''])).toMatchObject({
      ok: false,
      optionsProblem: 'optionsRequired',
      optionsProblemIndex: 1,
    });
  });

  it('refuses two options that say the same thing, whatever the case or spacing', () => {
    expect(checkDraft('Next?', ['Hushle', 'Quiz', 'hushle '])).toMatchObject({
      ok: false,
      optionsProblem: 'duplicateOption',
      optionsProblemIndex: 2,
    });
    expect(checkDraft('Next?', ['Watch  Party', 'watch party'])).toMatchObject({ optionsProblem: 'duplicateOption' });
    // Blank rows are ignored, not "duplicates" of each other.
    expect(checkDraft('Next?', ['Hushle', '', 'Quiz', ''])).toMatchObject({ ok: true, optionsProblemIndex: -1 });
  });

  it('reports both problems at once, so the host fixes the form in one pass', () => {
    const check = checkDraft('', ['only one']);
    expect(check.questionProblem).toBe('questionRequired');
    expect(check.optionsProblem).toBe('optionsRequired');
  });

  it('never produces a draft the server would refuse', () => {
    const long = 'x'.repeat(POLL_MAX_QUESTION_LENGTH + 20);
    const drafts = Array.from({ length: POLL_MAX_OPTIONS + 2 }, (_, i) => `${i}`.padEnd(POLL_MAX_OPTION_LENGTH + 5, 'y'));
    const check = checkDraft(long, drafts);
    expect(check.ok).toBe(true);
    expect(pollValidateAction({ type: 'open-poll', hostId: 'host', question: check.question, options: check.options })).toBeNull();
  });
});

describe('poll panel — remembering the viewer’s own choice', () => {
  it('keys the memory by viewer and by poll', () => {
    const a = voteStorageKey('2026-09-28T10:00:00.000Z', 'user-1');
    expect(a).not.toBe(voteStorageKey('2026-09-28T10:00:00.000Z', 'user-2'));
    expect(a).not.toBe(voteStorageKey('2026-09-28T10:05:00.000Z', 'user-1'));
  });
});
