/**
 * Mail counters (docs/EMAIL.md §2.3, §6): the instance-wide daily send
 * count behind `mailDailyLimit`, and recent failures for Doctor.
 *
 * Kept in the bot-protection store (`lib/captcha/store.ts`): Redis in
 * production (or with LOBBYFORGE_RATE_LIMIT_STORE=redis), memory otherwise.
 * Keys: `lf:<env>:mail:sent:<YYYY-MM-DD>` (UTC day), `lf:<env>:mail:failures`,
 * `lf:<env>:mail:auth-failures` (24 h windows), `lf:<env>:mail:last-failure`
 * and `lf:<env>:mail:last-success` (7 days).
 *
 * A broken store never blocks mail: counting fails open (logged), so a
 * Redis outage cannot stop verification emails — the provider's own limit
 * is the backstop then.
 */
import { memoryCounter, memoryGet, memoryIncrWithTtl, memorySet, storeCounter, storeGet, storeIncrWithTtl, storeSet } from '@/lib/captcha/store';
import type { MailOutcome } from './types';

const DAY_MS = 24 * 60 * 60_000;

function mailKey(name: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:mail:${name}`;
}

/** The UTC day the daily limit counts in. */
export function mailDayKey(now = new Date()): string {
  return mailKey(`sent:${now.toISOString().slice(0, 10)}`);
}

async function guarded<T>(op: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await op();
  } catch (error) {
    console.error('[mail] counter store unavailable', JSON.stringify((error as Error).message));
    return fallback();
  }
}

/** Messages sent (or being sent) today. */
export async function sentToday(): Promise<number> {
  const key = mailDayKey();
  return (await guarded(() => storeCounter(key), () => memoryCounter(key))).count;
}

/** Count one send toward today's total; returns the new total. */
export async function countSend(): Promise<number> {
  const key = mailDayKey();
  return (await guarded(() => storeIncrWithTtl(key, 2 * DAY_MS), () => memoryIncrWithTtl(key, 2 * DAY_MS))).count;
}

export interface MailFailureInfo {
  at: number;
  result: MailOutcome['result'];
  detail?: MailOutcome['detail'];
}

/** Remember a failed send (codes only — never an address or server text). */
export async function recordMailFailure(outcome: MailOutcome): Promise<void> {
  const info: MailFailureInfo = { at: Date.now(), result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  const failures = mailKey('failures');
  await guarded(() => storeIncrWithTtl(failures, DAY_MS), () => memoryIncrWithTtl(failures, DAY_MS));
  if (outcome.result === 'auth') {
    const auth = mailKey('auth-failures');
    await guarded(() => storeIncrWithTtl(auth, DAY_MS), () => memoryIncrWithTtl(auth, DAY_MS));
  }
  const last = mailKey('last-failure');
  await guarded(() => storeSet(last, JSON.stringify(info), DAY_MS), () => memorySet(last, JSON.stringify(info), DAY_MS));
}

/** Remember that a message went out (Doctor: has anything worked since the last failure?). */
export async function recordMailSuccess(): Promise<void> {
  const key = mailKey('last-success');
  const now = String(Date.now());
  await guarded(() => storeSet(key, now, 7 * DAY_MS), () => memorySet(key, now, 7 * DAY_MS));
}

export interface MailFailureStats {
  failures: number;
  authFailures: number;
  last: MailFailureInfo | null;
  /** When a message last went out (ms), or null. */
  lastSuccessAt: number | null;
}

/** Failures in the last day (Doctor). */
export async function mailFailureStats(): Promise<MailFailureStats> {
  const failures = mailKey('failures');
  const auth = mailKey('auth-failures');
  const last = mailKey('last-failure');
  const success = mailKey('last-success');
  const [f, a, raw, ok] = await Promise.all([
    guarded(() => storeCounter(failures), () => memoryCounter(failures)),
    guarded(() => storeCounter(auth), () => memoryCounter(auth)),
    guarded(() => storeGet(last), () => memoryGet(last)),
    guarded(() => storeGet(success), () => memoryGet(success)),
  ]);
  let parsed: MailFailureInfo | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as MailFailureInfo;
    } catch {
      parsed = null;
    }
  }
  const lastSuccessAt = ok && Number.isFinite(Number(ok)) ? Number(ok) : null;
  return { failures: f.count, authFailures: a.count, last: parsed, lastSuccessAt };
}
