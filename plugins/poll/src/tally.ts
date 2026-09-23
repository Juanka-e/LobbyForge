// Type-only: erased at compile time, so this does NOT create the
// runtime cycle described below.
import type { PollOption } from './index';

/**
 * How a poll's result is read.
 *
 * This lives outside `index.ts` because BOTH the reducer and the panel
 * need it, and the panel cannot import runtime values from `index.ts` —
 * `index.ts` imports the panel, so the cycle would hit `POLL_PLUGIN_ID`
 * before its initialiser ran (a TDZ ReferenceError on first import).
 *
 * It takes just the options: the client never holds a `PollState`,
 * because the ballot box is stripped server-side to keep votes
 * anonymous. One implementation, so the winner the panel highlights is
 * always the winner the reducer would name.
 */
export function pollTally(state: { options: PollOption[] }): { optionId: string; votes: number }[] {
  return state.options.map((option) => ({ optionId: option.id, votes: option.votes }));
}

/** The single option with the strictly highest non-zero count, else null. */
export function pollLeader(state: { options: PollOption[] }): string | null {
  let best: { id: string; votes: number } | null = null;
  let tie = false;
  for (const option of state.options) {
    if (!best || option.votes > best.votes) {
      best = { id: option.id, votes: option.votes };
      tie = false;
    } else if (option.votes === best.votes && option.votes > 0) {
      tie = true;
    }
  }
  return best && best.votes > 0 && !tie ? best.id : null;
}
