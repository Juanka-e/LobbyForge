/**
 * A sign-up form's password meter. Advice, not a gate: the server's only
 * rule is the minimum length (`/api/auth/register` requires 12), and
 * `tooShort` is the one level that blocks submitting.
 *
 * Length matters most (NIST SP 800-63B); variety helps a short password
 * more than a long one, and a password made of a handful of characters
 * repeated is weak however long it is.
 */

export const MIN_PASSWORD_LENGTH = 12;

export type PasswordStrengthLevel = 'empty' | 'tooShort' | 'fair' | 'strong' | 'veryStrong';

export interface PasswordStrength {
  level: PasswordStrengthLevel;
  /** Filled bars on a four-bar meter. */
  score: 0 | 1 | 2 | 3 | 4;
}

const CHARACTER_CLASSES = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];

export function passwordStrength(password: string): PasswordStrength {
  if (!password) return { level: 'empty', score: 0 };
  // UTF-16 length, the same count the server's `min(12)` uses.
  if (password.length < MIN_PASSWORD_LENGTH) return { level: 'tooShort', score: 1 };
  const classes = CHARACTER_CLASSES.filter((pattern) => pattern.test(password)).length;
  const distinct = new Set(Array.from(password)).size;
  const length = password.length;
  if (distinct < 5 || (classes === 1 && length < 16)) return { level: 'fair', score: 2 };
  if ((length >= 16 && classes >= 3) || (length >= 24 && classes >= 2)) return { level: 'veryStrong', score: 4 };
  return { level: 'strong', score: 3 };
}
