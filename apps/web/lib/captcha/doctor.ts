/**
 * Doctor checks for bot protection (docs/CAPTCHA.md §8):
 *   - an external provider is selected but a key is missing;
 *   - the stored secret cannot be decrypted (the session secret changed);
 *   - siteverify reports a bad secret (the Turnstile probe, or — for
 *     reCAPTCHA, whose probe cannot tell — a real verification), or the
 *     provider is unreachable;
 *   - Cloudflare's or Google's test keys are in use in production;
 *   - Redis is unavailable, so ALTCHA cannot block replays (production
 *     then refuses every challenge-protected sign-up and new guest);
 *   - LOBBYFORGE_CAPTCHA_PROVIDER holds an unknown value.
 *
 * `buildCaptchaChecks` is pure (the caller gathers the facts);
 * `collectCaptchaChecks` gathers them — it reads the settings and uses the
 * reachability probe's cached result (at most 60 s old), probing once when
 * there is none.
 */
import { AlertLevel, DoctorCategory, type DoctorCheck } from '@lobbyforge/core';
import type { BreakerState, ProbeResult } from './breaker';
import { isTestSecretKey, isTestSiteKey } from './providers';
import type { ResolvedCaptchaSettings } from './settings';
import { isExternalProvider, type CaptchaProvider } from './types';

export interface CaptchaDoctorFacts {
  provider: CaptchaProvider;
  siteKeySet: boolean;
  secretState: ResolvedCaptchaSettings['secretState'];
  siteKeyIsTest: boolean;
  secretIsTest: boolean;
  invalidEnvProvider: string | null;
  settingsLoaded: boolean;
  probe: ProbeResult | null;
  breaker: BreakerState | null;
  /** A real verification got "invalid secret" back in the last day (only meaningful for reCAPTCHA, whose probe cannot tell). */
  badSecretSeen: boolean;
  production: boolean;
  redisReachable: boolean | null;
}

const PROVIDER_NAMES: Record<CaptchaProvider, string> = {
  none: 'off',
  altcha: 'ALTCHA (built in)',
  turnstile: 'Cloudflare Turnstile',
  recaptcha: 'Google reCAPTCHA',
};

function check(id: string, ok: boolean, level: AlertLevel, message: string, detail?: Record<string, unknown>): DoctorCheck {
  return { id, category: DoctorCategory.SERVICES, ok, level, message, ...(detail ? { detail } : {}) };
}

export function buildCaptchaChecks(facts: CaptchaDoctorFacts): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const name = PROVIDER_NAMES[facts.provider];

  if (facts.invalidEnvProvider) {
    out.push(
      check(
        'captcha_env',
        false,
        AlertLevel.WARNING,
        `LOBBYFORGE_CAPTCHA_PROVIDER=${JSON.stringify(facts.invalidEnvProvider)} is not one of none, altcha, turnstile, recaptcha and is ignored.`
      )
    );
  }
  if (!facts.settingsLoaded) {
    out.push(check('captcha_settings', false, AlertLevel.WARNING, 'Bot protection settings could not be read; the defaults (ALTCHA) apply until the database answers.'));
  }

  if (facts.provider === 'none') {
    out.push(check('captcha', true, AlertLevel.INFO, 'Bot protection is off (provider "none"). Sign-up and new guests are only rate limited.'));
    return out;
  }

  if (isExternalProvider(facts.provider)) {
    const provider = facts.provider;
    if (!facts.siteKeySet || facts.secretState === 'unset') {
      const missing = [!facts.siteKeySet ? 'site key' : null, facts.secretState === 'unset' ? 'secret key' : null].filter(Boolean).join(' and ');
      out.push(
        check(
          'captcha_keys',
          false,
          AlertLevel.WARNING,
          `${name} is selected but its ${missing} is missing, so ALTCHA is used instead. Add the keys in Admin → Settings → Authentication → Bot protection.`,
          { provider }
        )
      );
    }
    if (facts.secretState === 'undecryptable') {
      out.push(
        check(
          'captcha_secret',
          false,
          AlertLevel.WARNING,
          `The stored ${name} secret cannot be decrypted — LOBBYFORGE_SESSION_SECRET changed since it was saved. ALTCHA is used instead; enter the secret again.`,
          { provider }
        )
      );
    }
    if (facts.probe === 'bad_secret') {
      out.push(check('captcha_siteverify', false, AlertLevel.WARNING, `${name} rejected the secret key (siteverify). ALTCHA is used instead; check the key pair.`, { provider }));
    } else if (facts.probe === 'unreachable') {
      out.push(check('captcha_siteverify', false, AlertLevel.WARNING, `${name} siteverify did not answer from this server. ALTCHA is used until it does.`, { provider }));
    } else if (provider === 'recaptcha' && facts.badSecretSeen) {
      // Google checks a real token before the secret, so this is the only
      // way a wrong reCAPTCHA secret shows. It does not switch to ALTCHA (a
      // token from another site can draw the same answer).
      out.push(
        check(
          'captcha_siteverify',
          false,
          AlertLevel.WARNING,
          `${name} answered "invalid secret" to a real verification in the last day. If people cannot pass the challenge, check the key pair (a token from another site can also cause this).`,
          { provider }
        )
      );
    }
    if (facts.production && (facts.siteKeyIsTest || facts.secretIsTest)) {
      out.push(
        check(
          'captcha_test_keys',
          false,
          AlertLevel.WARNING,
          `${name} test keys are in use in production — every challenge passes, so there is no protection. Replace them with real keys.`,
          { provider }
        )
      );
    }
  }

  // ALTCHA is used whenever it is the provider and as the fallback of an
  // external one, so its replay store matters either way.
  if (facts.production && facts.redisReachable === false) {
    out.push(
      check(
        'captcha_replay_store',
        false,
        AlertLevel.CRITICAL,
        'Redis is unavailable, so ALTCHA cannot block replayed solutions: challenge-protected sign-ups and new guests are refused until it is back.'
      )
    );
  }

  if (!out.some((c) => !c.ok)) {
    const fallback = facts.breaker?.open ? ` Its breaker is open (${facts.breaker.reason}); ALTCHA is served until it closes.` : '';
    out.push(check('captcha', true, AlertLevel.INFO, `Bot protection: ${name}.${fallback}`, { provider: facts.provider }));
  }
  return out;
}

/** Gather the facts and build the checks. Never throws. */
export async function collectCaptchaChecks(input: { redisReachable: boolean | null }): Promise<DoctorCheck[]> {
  try {
    const { resolveCaptchaSettings, externalProviderConfigured } = await import('./settings');
    const { getBreakerState, lastBadSecretSeen, lastProbe, runProbe, PROBE_INTERVAL_MS } = await import('./breaker');
    const settings = await resolveCaptchaSettings({ fresh: true });
    let probe: ProbeResult | null = null;
    let breaker: BreakerState | null = null;
    let badSecretSeen = false;
    if (isExternalProvider(settings.provider)) {
      breaker = await getBreakerState(settings.provider);
      badSecretSeen = (await lastBadSecretSeen(settings.provider)) !== null;
      if (externalProviderConfigured(settings)) {
        const cached = await lastProbe(settings.provider, settings.secretKey!);
        probe = cached && Date.now() - cached.at <= PROBE_INTERVAL_MS ? cached.result : await runProbe(settings.provider, settings.secretKey!);
      }
    }
    const external = isExternalProvider(settings.provider) ? settings.provider : null;
    return buildCaptchaChecks({
      provider: settings.provider,
      siteKeySet: Boolean(settings.siteKey),
      secretState: settings.secretState,
      siteKeyIsTest: external ? isTestSiteKey(external, settings.siteKey) : false,
      secretIsTest: external ? isTestSecretKey(external, settings.secretKey) : false,
      invalidEnvProvider: settings.env.invalidProvider,
      settingsLoaded: settings.loaded,
      probe,
      breaker,
      badSecretSeen,
      production: process.env.NODE_ENV === 'production',
      redisReachable: input.redisReachable,
    });
  } catch (error) {
    console.error('[doctor] bot protection checks failed', (error as Error).message);
    return [check('captcha_settings', false, AlertLevel.WARNING, 'Bot protection settings could not be checked.')];
  }
}

/**
 * Is ALTCHA what visitors get right now — configured, or standing in for a
 * misconfigured / unreachable external provider? Doctor's `secure_origin`
 * check is critical then (ALTCHA needs Web Crypto, i.e. a secure context).
 * Never throws; when the settings cannot be read the default (ALTCHA) applies.
 */
export async function isAltchaActive(): Promise<boolean> {
  try {
    const { resolveCaptchaSettings } = await import('./settings');
    const { effectiveCaptchaProvider } = await import('./verify');
    return (await effectiveCaptchaProvider(await resolveCaptchaSettings())).provider === 'altcha';
  } catch {
    return true;
  }
}
