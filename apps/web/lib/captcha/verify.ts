/**
 * `verifyCaptcha` — the one entry point protected routes use
 * (docs/CAPTCHA.md §5), and `effectiveCaptchaProvider`, which decides what
 * the client must render now (§4.1).
 *
 * Which tokens are accepted:
 * - the configured external provider's, while it is healthy — and ONLY
 *   those, so a bot cannot pick the weaker path;
 * - ALTCHA's, when ALTCHA is configured, or when the external provider is
 *   misconfigured (no keys, a secret that cannot be decrypted) or its
 *   breaker is open. A token from the external provider then answers
 *   `unavailable`, which tells the client to fetch the config again (it
 *   now says `altcha`).
 */
import { verifyAltchaToken } from './altcha';
import { getBreakerState, maybeProbe, recordBadSecretSeen, recordProviderFailure, recordProviderSuccess } from './breaker';
import { MissingSessionSecretError } from './keys';
import { expectedAppHosts, verifyRecaptcha, verifyTurnstile, type ProviderOutcome } from './providers';
import { externalProviderConfigured, resolveCaptchaSettings, type ResolvedCaptchaSettings } from './settings';
import { signalAddress } from './signals';
import { isExternalProvider, type CaptchaProvider, type CaptchaSurface, type CaptchaVerdict, type ExternalCaptchaProvider } from './types';

export interface EffectiveProvider {
  /** What the client must render now. */
  provider: CaptchaProvider;
  /** Why an external provider is not in use, when it is configured but replaced by ALTCHA. */
  fallback: 'misconfigured' | 'breaker' | null;
  breakerUntil: number | null;
}

export async function effectiveCaptchaProvider(settings: ResolvedCaptchaSettings): Promise<EffectiveProvider> {
  const configured = settings.provider;
  if (!isExternalProvider(configured)) return { provider: configured, fallback: null, breakerUntil: null };
  if (!externalProviderConfigured(settings)) return { provider: 'altcha', fallback: 'misconfigured', breakerUntil: null };
  const breaker = await getBreakerState(configured);
  if (breaker.open) return { provider: 'altcha', fallback: 'breaker', breakerUntil: breaker.until };
  return { provider: configured, fallback: null, breakerUntil: null };
}

export interface VerifyCaptchaInput {
  surface: CaptchaSurface;
  token: string | null | undefined;
  /** Which provider produced the token (`captchaProvider`); defaults to the one in force. */
  provider?: string | null;
  req: Request;
  /** Already-resolved settings (the guards pass them to avoid a second read). */
  settings?: ResolvedCaptchaSettings;
}

async function verifyExternal(
  provider: ExternalCaptchaProvider,
  settings: ResolvedCaptchaSettings,
  token: string,
  surface: CaptchaSurface,
  req: Request
): Promise<CaptchaVerdict> {
  const input = {
    token,
    secret: settings.secretKey!,
    surface,
    expectedHosts: expectedAppHosts(req),
    remoteIp: signalAddress(req),
  };
  const outcome: ProviderOutcome =
    provider === 'turnstile'
      ? await verifyTurnstile(input)
      : await verifyRecaptcha({ ...input, version: settings.options.recaptchaVersion, minScore: settings.options.recaptchaMinScore });
  switch (outcome) {
    case 'unavailable':
      await recordProviderFailure(provider);
      return 'unavailable';
    case 'bad_secret':
      // NOT a reason to open the breaker by itself: a token minted with
      // someone else's key can draw the same answer, and an attacker could
      // keep the instance on the ALTCHA fallback that way. The token is
      // refused; the event is recorded for Doctor; for Turnstile the dummy
      // token probe (which only the real secret can pass) is asked to
      // confirm, and IT opens the breaker when the secret really is wrong.
      await recordBadSecretSeen(provider);
      if (provider === 'turnstile' && settings.secretKey) void maybeProbe(provider, settings.secretKey).catch(() => undefined);
      return 'invalid';
    default:
      await recordProviderSuccess(provider);
      return outcome;
  }
}

export async function verifyCaptcha(input: VerifyCaptchaInput): Promise<CaptchaVerdict> {
  const settings = input.settings ?? (await resolveCaptchaSettings());
  if (settings.provider === 'none') return 'ok';
  const effective = await effectiveCaptchaProvider(settings);
  const token = input.token?.trim();
  if (!token) return 'missing';
  const claimed = input.provider || effective.provider;

  if (effective.provider === 'altcha') {
    if (claimed !== 'altcha') {
      // A token from the configured external provider while it is replaced
      // by ALTCHA: the client is out of date, not wrong.
      return claimed === settings.provider ? 'unavailable' : 'invalid';
    }
    try {
      return await verifyAltchaToken(token, input.surface);
    } catch (error) {
      if (error instanceof MissingSessionSecretError) return 'misconfigured';
      throw error;
    }
  }

  if (!isExternalProvider(effective.provider) || claimed !== effective.provider) return 'invalid';
  return verifyExternal(effective.provider, settings, token, input.surface, input.req);
}
