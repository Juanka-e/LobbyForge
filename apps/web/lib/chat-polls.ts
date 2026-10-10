/**
 * Polls in text channels (docs/CHAT_POLLS.md) — the pure rules, shared by
 * the API routes and the lobby: the limits, the draft check, the per-viewer
 * projection and how a realtime update is applied. No React, no database,
 * no Node built-ins, so client components can import it.
 *
 * The voice-room Poll activity (plugins/poll) has its own, smaller limits
 * and stays separate: this is a message kind, not an activity.
 */
import { z } from 'zod';

export const CHAT_POLL_QUESTION_MAX = 300;
export const CHAT_POLL_OPTION_MAX = 80;
export const CHAT_POLL_MIN_OPTIONS = 2;
export const CHAT_POLL_MAX_OPTIONS = 10;
/** The durations the create dialog offers, in hours: 1 h, 4 h, 8 h, 24 h, 3 days, 7 days. */
export const CHAT_POLL_DURATIONS_HOURS = [1, 4, 8, 24, 72, 168] as const;
export type ChatPollDurationHours = (typeof CHAT_POLL_DURATIONS_HOURS)[number];
export const CHAT_POLL_DEFAULT_DURATION_HOURS: ChatPollDurationHours = 24;
/** Polls are posted in these channel types only. */
export const CHAT_POLL_CHANNEL_TYPES: readonly string[] = ['text', 'announcement'];

export function isPollChannelType(type: string | null | undefined): boolean {
  return typeof type === 'string' && CHAT_POLL_CHANNEL_TYPES.includes(type);
}

/**
 * The comparison key of an option: trimmed, inner whitespace collapsed,
 * case-folded. "Pizza", " pizza " and "PIZZA" are the same option. The
 * dotted capital İ lower-cases to "i" + a combining dot in JavaScript; the
 * dot is dropped so "İstanbul" and "istanbul" match too.
 */
export function pollOptionKey(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase().replace(/i̇/g, 'i');
}

export type ChatPollQuestionProblem = 'required' | 'tooLong' | null;
export type ChatPollOptionsProblem = 'tooFew' | 'tooMany' | null;
export type ChatPollOptionProblem = 'tooLong' | 'duplicate' | null;

export interface ChatPollDraftCheck {
  /** The question as it will be sent: trimmed. */
  question: string;
  /** The filled-in options as they will be sent: trimmed, blanks skipped, in order. */
  options: string[];
  questionProblem: ChatPollQuestionProblem;
  optionsProblem: ChatPollOptionsProblem;
  /** One entry per draft row (blank rows are never a problem — they are skipped). */
  optionProblems: ChatPollOptionProblem[];
  ok: boolean;
}

/**
 * Check a draft the way the create route will, so the dialog never sends a
 * poll the server refuses. Blank rows are skipped (the dialog may keep an
 * empty row around); the server itself accepts no blank option.
 */
export function checkChatPollDraft(question: string, drafts: readonly string[]): ChatPollDraftCheck {
  const trimmedQuestion = question.trim();
  const questionProblem: ChatPollQuestionProblem =
    trimmedQuestion.length === 0 ? 'required' : trimmedQuestion.length > CHAT_POLL_QUESTION_MAX ? 'tooLong' : null;

  const seen = new Set<string>();
  const options: string[] = [];
  const optionProblems = drafts.map((draft): ChatPollOptionProblem => {
    const text = draft.trim();
    if (!text) return null;
    options.push(text);
    if (text.length > CHAT_POLL_OPTION_MAX) return 'tooLong';
    const key = pollOptionKey(text);
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
    return null;
  });
  const optionsProblem: ChatPollOptionsProblem =
    options.length < CHAT_POLL_MIN_OPTIONS ? 'tooFew' : options.length > CHAT_POLL_MAX_OPTIONS ? 'tooMany' : null;

  return {
    question: trimmedQuestion,
    options,
    questionProblem,
    optionsProblem,
    optionProblems,
    ok: questionProblem === null && optionsProblem === null && optionProblems.every((p) => p === null),
  };
}

const trimmed = (max: number) => z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(max));

/** The create route's body. Options are trimmed; two that share a `pollOptionKey` are refused. */
export const CreateChatPollSchema = z
  .object({
    question: trimmed(CHAT_POLL_QUESTION_MAX),
    options: z.array(trimmed(CHAT_POLL_OPTION_MAX)).min(CHAT_POLL_MIN_OPTIONS).max(CHAT_POLL_MAX_OPTIONS),
    allowMultiple: z.boolean().optional().default(false),
    durationHours: z
      .number()
      .refine((h): h is ChatPollDurationHours => (CHAT_POLL_DURATIONS_HOURS as readonly number[]).includes(h))
      .optional()
      .default(CHAT_POLL_DEFAULT_DURATION_HOURS),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.options.forEach((option, index) => {
      const key = pollOptionKey(option);
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', index], message: 'duplicate' });
      seen.add(key);
    });
  });

export type CreateChatPollBody = z.infer<typeof CreateChatPollSchema>;

/** The vote route's body: the chosen option indexes. Checked against the poll by `checkVoteChoices`. */
export const ChatPollVoteSchema = z.object({ choices: z.array(z.number().int()).min(1).max(CHAT_POLL_MAX_OPTIONS) }).strict();

export type VoteChoicesProblem = 'out_of_range' | 'duplicate' | 'single_choice' | null;

/** A vote is 1 option (single choice) or up to every option (multiple), each once, each on the poll. */
export function checkVoteChoices(
  choices: readonly number[],
  poll: { optionCount: number; allowMultiple: boolean }
): VoteChoicesProblem {
  if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= poll.optionCount)) return 'out_of_range';
  if (new Set(choices).size !== choices.length) return 'duplicate';
  if (!poll.allowMultiple && choices.length !== 1) return 'single_choice';
  if (choices.length > poll.optionCount) return 'out_of_range';
  return null;
}

/** An option's share of the votes cast as a whole percentage; 0 while nobody has voted. */
export function pollSharePercent(votes: number, totalVotes: number): number {
  if (!(totalVotes > 0)) return 0;
  return Math.round(((Number(votes) || 0) / totalVotes) * 100);
}

/** A poll as one viewer may see it. `votes` is null until the results are visible to them. */
export interface ChatPollView {
  id: string;
  messageId: string;
  question: string;
  options: Array<{ text: string; votes: number | null }>;
  allowMultiple: boolean;
  closesAt: string;
  closedAt: string | null;
  closed: boolean;
  /** How many members have voted — always shown. */
  totalVoters: number;
  /** The viewer's own choices (option indexes); empty before they vote. */
  myChoices: number[];
  /** Counts show once the viewer has voted, and to everyone once the poll has closed. */
  resultsVisible: boolean;
}

/** What the server knows about a poll — structurally the db row with its tally. */
export interface ChatPollSource {
  id: string;
  messageId: string;
  question: string;
  options: readonly string[];
  allowMultiple: boolean;
  closesAt: Date;
  closedAt: Date | null;
  counts: readonly number[];
  totalVoters: number;
  viewerChoices: readonly number[];
}

export function isChatPollClosed(poll: { closesAt: Date | string; closedAt: Date | string | null }, now: Date = new Date()): boolean {
  if (poll.closedAt) return true;
  return new Date(poll.closesAt).getTime() <= now.getTime();
}

/**
 * The per-viewer projection. The ONLY shape a poll leaves the server in:
 * counts (when visible), the number of voters, and the viewer's own
 * choices — never who chose what.
 */
export function projectChatPoll(poll: ChatPollSource, now: Date = new Date()): ChatPollView {
  const closed = isChatPollClosed(poll, now);
  const myChoices = [...poll.viewerChoices].sort((a, b) => a - b);
  const resultsVisible = closed || myChoices.length > 0;
  return {
    id: poll.id,
    messageId: poll.messageId,
    question: poll.question,
    options: poll.options.map((text, index) => ({ text, votes: resultsVisible ? (poll.counts[index] ?? 0) : null })),
    allowMultiple: poll.allowMultiple,
    closesAt: poll.closesAt.toISOString(),
    closedAt: poll.closedAt?.toISOString() ?? null,
    closed,
    totalVoters: poll.totalVoters,
    myChoices,
    resultsVisible,
  };
}

/** The realtime `poll_update` payload: ids and public counts, never a voter. */
export interface ChatPollUpdate {
  id: string;
  messageId: string;
  counts: number[];
  totalVoters: number;
  closesAt: string;
  closedAt: string | null;
  closed: boolean;
}

export function toChatPollUpdate(poll: ChatPollSource, now: Date = new Date()): ChatPollUpdate {
  return {
    id: poll.id,
    messageId: poll.messageId,
    counts: poll.options.map((_, index) => poll.counts[index] ?? 0),
    totalVoters: poll.totalVoters,
    closesAt: poll.closesAt.toISOString(),
    closedAt: poll.closedAt?.toISOString() ?? null,
    closed: isChatPollClosed(poll, now),
  };
}

/**
 * Apply a realtime update to what this viewer sees. A viewer who has not
 * voted on an open poll keeps the counts hidden (only the voter total
 * moves); once the poll closes everyone sees them.
 */
export function applyChatPollUpdate(view: ChatPollView, update: ChatPollUpdate, now: Date = new Date()): ChatPollView {
  if (update.id !== view.id) return view;
  const closed = update.closed || isChatPollClosed(update, now);
  const resultsVisible = closed || view.myChoices.length > 0;
  return {
    ...view,
    options: view.options.map((option, index) => ({ ...option, votes: resultsVisible ? (update.counts[index] ?? 0) : null })),
    closesAt: update.closesAt,
    closedAt: update.closedAt,
    closed,
    totalVoters: update.totalVoters,
    resultsVisible,
  };
}

/** Read a poll view from an API or realtime payload; anything malformed is not a poll. */
export function asChatPollView(value: unknown): ChatPollView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.messageId !== 'string' || typeof raw.question !== 'string') return null;
  if (!Array.isArray(raw.options) || typeof raw.closesAt !== 'string') return null;
  const options = raw.options.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const o = option as Record<string, unknown>;
    if (typeof o.text !== 'string') return [];
    return [{ text: o.text, votes: typeof o.votes === 'number' ? o.votes : null }];
  });
  const myChoices = Array.isArray(raw.myChoices) ? raw.myChoices.filter((n): n is number => Number.isInteger(n)) : [];
  return {
    id: raw.id,
    messageId: raw.messageId,
    question: raw.question,
    options,
    allowMultiple: raw.allowMultiple === true,
    closesAt: raw.closesAt,
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
    closed: raw.closed === true,
    totalVoters: typeof raw.totalVoters === 'number' ? raw.totalVoters : 0,
    myChoices,
    resultsVisible: raw.resultsVisible === true,
  };
}

/** Read a `poll_update` payload; anything malformed is ignored. */
export function asChatPollUpdate(value: unknown): ChatPollUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.messageId !== 'string' || typeof raw.closesAt !== 'string') return null;
  if (!Array.isArray(raw.counts) || typeof raw.totalVoters !== 'number') return null;
  return {
    id: raw.id,
    messageId: raw.messageId,
    counts: raw.counts.map((n) => (typeof n === 'number' && n >= 0 ? n : 0)),
    totalVoters: raw.totalVoters,
    closesAt: raw.closesAt,
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
    closed: raw.closed === true,
  };
}

/** The poll id a message's metadata names (`metadata.poll.id`), or null. */
export function readMessagePollId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const poll = (metadata as Record<string, unknown>).poll;
  if (!poll || typeof poll !== 'object') return null;
  const id = (poll as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

export type TimeLeft = { unit: 'minutes' | 'hours' | 'days'; count: number } | { unit: 'lessThanMinute' } | { unit: 'closed' };

/** How long until `closesAt`, rounded up to the unit the card shows (minutes under 1 h, hours under 2 days, days beyond). */
export function pollTimeLeft(closesAt: string, closed: boolean, now: Date = new Date()): TimeLeft {
  const ms = new Date(closesAt).getTime() - now.getTime();
  if (closed || ms <= 0) return { unit: 'closed' };
  const minutes = Math.ceil(ms / 60_000);
  if (ms < 60_000) return { unit: 'lessThanMinute' };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.ceil(ms / 86_400_000) };
}
