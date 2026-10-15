/**
 * Newest-first pages with a `before` cursor that cannot skip rows
 * (security review 2026-10, A11).
 *
 * Postgres keeps `created_at` to the microsecond; the driver hands it back
 * as a JavaScript Date, which keeps the millisecond (truncated). A client
 * pages back with `before` = the last row's createdAt, so the cursor is a
 * whole millisecond, and `created_at < before` (the same rows as
 * `date_trunc('milliseconds', created_at) < before`) leaves out EVERY row
 * of that millisecond. When LIMIT cut a page inside a millisecond, the
 * older rows of it were on neither page: lost.
 *
 * The fix keeps the cursor and makes every page millisecond-complete: when
 * a page is full, the rows that share its last row's millisecond and did
 * not fit are appended (same order). The next page then starts strictly
 * below that millisecond and misses nothing; a page can run past `limit`
 * by those rows (normally none — they share a millisecond).
 */
import { and, gte, lt, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** `column` lies in the same millisecond as `at` (index-friendly range, no date_trunc). */
export function inMillisecondOf(column: AnyPgColumn, at: Date): SQL {
  return and(gte(column, at), lt(column, new Date(at.getTime() + 1)))!;
}

/**
 * `page` (newest first, at most `limit` rows) completed with the rows of
 * its last row's millisecond that LIMIT left out. `loadRest(boundary,
 * seenIds)` returns the rows in `boundary`'s millisecond whose ids are not
 * in `seenIds`, in the page's order.
 */
export async function completeLastMillisecond<T extends { id: string; createdAt: Date }>(
  page: T[],
  limit: number,
  loadRest: (boundary: Date, seenIds: string[]) => Promise<T[]>
): Promise<T[]> {
  const last = page[page.length - 1];
  if (!last || page.length < limit) return page;
  const boundary = last.createdAt;
  const seenIds = page.filter((row) => row.createdAt.getTime() === boundary.getTime()).map((row) => row.id);
  const rest = await loadRest(boundary, seenIds);
  return rest.length > 0 ? [...page, ...rest] : page;
}
