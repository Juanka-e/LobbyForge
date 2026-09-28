/**
 * The Poll panel's rules, kept free of React and of text so they can be
 * tested on their own: when results show, how a share is rounded, what a
 * draft needs before it can open. The panel maps the codes returned here
 * onto its translated messages.
 *
 * Imports from `./index` are TYPE-only — `index.ts` imports the panel, so
 * a runtime import back would be the ESM cycle `constants.ts` describes.
 */
import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MIN_OPTIONS,
} from './constants';
import type { PollOption } from './index';

export type PollPhase = 'idle' | 'open' | 'closed';

/** Whatever the host handed over, as a phase the panel knows how to draw. */
export function pollPhaseOf(value: unknown): PollPhase {
  return value === 'open' || value === 'closed' ? value : 'idle';
}

/**
 * Results show once this viewer has nothing left to do: the poll has
 * closed, or they have already voted. Before that the options are plain
 * choices, so the running tally cannot sway anyone's vote.
 */
export function resultsVisible(phase: PollPhase, hasVoted: boolean): boolean {
  return phase === 'closed' || (phase === 'open' && hasVoted);
}

/** Vote counts only — the panel never knows who voted for what. */
export function totalVotes(options: readonly PollOption[]): number {
  return options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0);
}

/** An option's share of the vote as a whole percentage; 0 while nobody has voted. */
export function sharePercent(votes: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round(((Number(votes) || 0) / total) * 100);
}

/**
 * Whether "3 of 5 players voted" can honestly be said. `players` is the
 * session's registered list, which is routinely SMALLER than the number of
 * ballots (any member may vote, and the host registers only the creator);
 * "3 of 1 players" would be worse than no denominator at all.
 */
export function showTurnout(playerCount: number, ballotCount: number): boolean {
  return playerCount > 1 && ballotCount <= playerCount;
}

export interface DraftCheck {
  /** The question as it will be sent: trimmed. */
  question: string;
  /** The non-empty options as they will be sent: trimmed, in order. */
  options: string[];
  questionProblem: 'questionRequired' | null;
  optionsProblem: 'optionsRequired' | 'duplicateOption' | null;
  /**
   * The draft row to send the host to when `optionsProblem` is set — the
   * first empty row, or the row repeating an earlier one. -1 otherwise.
   */
  optionsProblemIndex: number;
  ok: boolean;
}

const sameText = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Checks a draft the way `pollValidateAction` will, so the panel never sends
 * a poll the server refuses — plus one rule of the panel's own: two options
 * that say the same thing (ignoring case and spacing) are a slip, never a
 * real choice, and would split the vote between identical rows.
 */
export function checkDraft(question: string, drafts: readonly string[]): DraftCheck {
  const trimmedQuestion = question.trim().slice(0, POLL_MAX_QUESTION_LENGTH);
  const options = drafts
    .map((draft) => draft.trim().slice(0, POLL_MAX_OPTION_LENGTH))
    .filter(Boolean)
    .slice(0, POLL_MAX_OPTIONS);
  const questionProblem = trimmedQuestion.length === 0 ? 'questionRequired' : null;

  let optionsProblem: DraftCheck['optionsProblem'] = null;
  let optionsProblemIndex = -1;
  if (options.length < POLL_MIN_OPTIONS) {
    optionsProblem = 'optionsRequired';
    optionsProblemIndex = drafts.findIndex((draft) => draft.trim().length === 0);
  } else {
    const seen = new Set<string>();
    optionsProblemIndex = drafts.findIndex((draft) => {
      if (!draft.trim()) return false;
      const key = sameText(draft);
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (optionsProblemIndex >= 0) optionsProblem = 'duplicateOption';
  }

  return {
    question: trimmedQuestion,
    options,
    questionProblem,
    optionsProblem,
    optionsProblemIndex,
    ok: questionProblem === null && optionsProblem === null,
  };
}

/**
 * Where this browser remembers which option its viewer picked. The server
 * never says (the ballot box holds WHO voted, not for what), so "Your vote"
 * can only come from here. Keyed by the poll's creation time, which a new
 * poll always changes and a close/reopen never does.
 */
export function voteStorageKey(pollCreatedAt: string, userId: string): string {
  return `lobbyforge.poll.vote:${userId}:${pollCreatedAt}`;
}
