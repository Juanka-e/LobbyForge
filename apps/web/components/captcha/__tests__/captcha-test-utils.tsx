import { act, configure } from '@testing-library/react';
import type { CaptchaConfig } from '../types';

/**
 * Shared bits for the bot-protection component tests. Tests mock the
 * ALTCHA loader (`vi.mock('@/components/captcha/altcha-loader', …)`), so
 * `<altcha-widget>` is an inert element here: a test "solves" it by
 * dispatching the widget's own `statechange` event.
 */

// Every bot-protection test waits on real timers (the formToken's fill
// time, config round trips, worker solves). Under a loaded full-suite run
// the default 1 s waitFor budget is too tight; importing this file widens it.
configure({ asyncUtilTimeout: 10_000 });

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function captchaConfig(overrides: Partial<CaptchaConfig> = {}): CaptchaConfig {
  const surface = overrides.surface ?? 'register';
  return {
    surface,
    required: true,
    mode: 'on',
    provider: 'altcha',
    siteKey: null,
    options: { turnstileAppearance: 'interaction-only', recaptchaVersion: 'v3' },
    formToken: surface === 'login' ? null : `1790000000000.${surface}.mac`,
    ...overrides,
  };
}

export function altchaWidget(): HTMLElement | null {
  return document.querySelector('altcha-widget');
}

/** Fire the widget's `statechange` the way ALTCHA does once the proof of work is done. */
export async function solveAltcha(payload = 'altcha-payload', element: HTMLElement | null = altchaWidget()): Promise<void> {
  if (!element) throw new Error('no <altcha-widget> rendered');
  await act(async () => {
    element.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'verified', payload } }));
  });
}

/** The parsed JSON body of the fetch calls to `url`, in order. */
export function bodiesFor(fetchMock: { mock: { calls: unknown[][] } }, url: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([target]) => target === url)
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
}
