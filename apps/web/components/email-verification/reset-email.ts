/**
 * The address a reset email was just asked for, carried from
 * `/forgot-password` to `/reset-password` so the code form starts filled
 * in. It stays in this tab only (sessionStorage) and never goes into a
 * URL, where it would end up in the history and in server logs.
 */
const KEY = 'lf-password-reset-email';

export function rememberResetEmail(email: string) {
  try {
    window.sessionStorage.setItem(KEY, email);
  } catch {
    // Private mode or blocked storage: the person types it again.
  }
}

export function recallResetEmail(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function forgetResetEmail() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored, or storage blocked.
  }
}
