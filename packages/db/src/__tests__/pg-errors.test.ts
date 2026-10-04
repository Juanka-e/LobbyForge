import { describe, expect, it } from 'vitest';
import { isPgUniqueViolation, pgErrorCode } from '../pg-errors.js';

describe('pgErrorCode', () => {
  it('reads the SQLSTATE from the driver error and from a Drizzle wrapper around it', () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "invites_code_unique"'), { code: '23505' });
    // Drizzle 0.45 throws DrizzleQueryError with the driver error as `cause`
    // (its own message carries the SQL and parameters, and has no `code`).
    const wrapped = new Error('Failed query: insert into "invites" …', { cause: driver });
    expect(pgErrorCode(driver)).toBe('23505');
    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(isPgUniqueViolation(wrapped)).toBe(true);
  });

  it('ignores anything that is not a SQLSTATE', () => {
    expect(pgErrorCode(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(pgErrorCode(new Error('plain'))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('23505')).toBeUndefined();
    expect(isPgUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
  });
});
