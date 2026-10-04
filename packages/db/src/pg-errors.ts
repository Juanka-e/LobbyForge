/**
 * Postgres error codes (SQLSTATE), read the same way everywhere.
 *
 * Drizzle 0.45 wraps driver errors in a `DrizzleQueryError` whose `cause`
 * is the postgres.js error carrying `code`. Checking only `err.code` on the
 * thrown error silently misses every wrapped one — a unique-violation retry
 * that never retries, or a 409 that becomes a 500.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `unique_violation` (23505), wrapped or not. */
export function isPgUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}
