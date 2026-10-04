'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCaptchaConfig, type CaptchaConfig, type CaptchaSurface } from './types';

export type CaptchaConfigStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CaptchaConfigState {
  status: CaptchaConfigStatus;
  config: CaptchaConfig | null;
  /** `Date.now()` when the config (and its formToken) arrived. */
  receivedAt: number | null;
  /** Bumps on every answer, so a challenge remounts for a new config. */
  version: number;
  /** Ask again — after `captcha_unavailable`, a used formToken, a load failure. */
  refetch: () => Promise<CaptchaConfig | null>;
  /** The answer of the fetch in flight, or null when none is. */
  pending: () => Promise<CaptchaConfig | null> | null;
}

export function captchaConfigUrl(surface: CaptchaSurface): string {
  return `/api/auth/captcha?surface=${encodeURIComponent(surface)}`;
}

/**
 * The public config for one surface (docs/CAPTCHA.md §4.1). `surface: null`
 * or `enabled: false` fetches nothing — sign-in, say, only asks once the
 * server answered `captcha_required`. A changed surface (an invite code
 * typed into the sign-up form) fetches again: a formToken and an ALTCHA
 * challenge are both bound to their surface.
 *
 * A failed fetch is `status: 'error'` with no config. Forms then send no
 * captcha fields at all and react to the server's refusal instead, so an
 * instance whose config route is down still behaves like one without
 * protection rather than breaking every form.
 */
export function useCaptchaConfig(
  surface: CaptchaSurface | null,
  { enabled = true }: { enabled?: boolean } = {}
): CaptchaConfigState {
  const [state, setState] = useState<Omit<CaptchaConfigState, 'refetch' | 'pending'>>({
    status: 'idle',
    config: null,
    receivedAt: null,
    version: 0,
  });
  const requestRef = useRef(0);
  const inflightRef = useRef<Promise<CaptchaConfig | null> | null>(null);
  /** The surface of the latest request, so the effect below never repeats one. */
  const requestedRef = useRef<CaptchaSurface | null>(null);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const refetch = useCallback((): Promise<CaptchaConfig | null> => {
    const target = surfaceRef.current;
    if (!target) return Promise.resolve(null);
    requestedRef.current = target;
    const request = ++requestRef.current;
    setState((current) => ({ ...current, status: 'loading' }));
    const run = (async () => {
      let config: CaptchaConfig | null = null;
      try {
        const response = await fetch(captchaConfigUrl(target), { credentials: 'same-origin', cache: 'no-store' });
        if (response.ok) {
          const parsed = parseCaptchaConfig(await response.json());
          config = parsed && parsed.surface === target ? parsed : null;
        }
      } catch {
        config = null;
      }
      // A newer request (another surface, a second retry) wins.
      if (request !== requestRef.current) return config;
      inflightRef.current = null;
      setState((current) => ({
        status: config ? 'ready' : 'error',
        config,
        receivedAt: config ? Date.now() : null,
        version: current.version + 1,
      }));
      return config;
    })();
    inflightRef.current = run;
    return run;
  }, []);

  const pending = useCallback(() => inflightRef.current, []);

  // The first fetch, and a new one per surface. Enabling the hook after an
  // explicit `refetch()` (a gate that just met `captcha_required`) does
  // not fetch the same surface a second time.
  useEffect(() => {
    if (!surface || !enabled || requestedRef.current === surface) return;
    void refetch();
  }, [surface, enabled, refetch]);

  return { ...state, refetch, pending };
}
