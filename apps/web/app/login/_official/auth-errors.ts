import type { Translator } from '@/lib/i18n/core';

/**
 * What to tell someone whose sign-in or sign-up the API refused. The
 * routes answer in English (`body.error`); the statuses a person can act
 * on get a sentence in their own language, and anything else falls back
 * to the route's message, then to a generic one.
 */

export function signInErrorMessage(t: Translator, status: number, apiError?: string): string {
  if (status === 400 || status === 401) return t('auth.official.error.invalidCredentials');
  if (status === 429) return t('auth.official.error.rateLimited');
  if (status === 503) return t('auth.login.error.sessionUnavailable');
  return apiError ?? t('auth.login.signInFailed');
}

export function signUpErrorMessage(t: Translator, status: number, apiError?: string): string {
  if (status === 409) return t('auth.official.error.emailTaken');
  if (status === 429) return t('auth.official.error.rateLimited');
  if (status === 503) return t('auth.official.error.signUpUnavailable');
  return apiError ?? t('auth.login.registerFailed');
}
