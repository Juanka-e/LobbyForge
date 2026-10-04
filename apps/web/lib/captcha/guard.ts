/**
 * The route side of bot protection (docs/CAPTCHA.md §4.3, §4.4, §7): what
 * the protected routes call after their zod parse, and the public config.
 *
 * Inside a route (§4.4):
 *   1. withApiSecurity (rate limit, origin)
 *   2. zod parse (the route's `.strict()` schema + `CaptchaBodyFields`)
 *   3. honeypot and form token  ┐ `guardCaptchaSurface` /
 *   4. verifyCaptcha            ┘ `guardSignInCaptcha`
 *   5. database work and password hashing
 *
 * A request that carries no challenge token at all, on a surface that needs
 * one, gets `captcha_required` before the form token is looked at: that is
 * the first contact of a client that has not rendered the widget yet (the
 * lobby's automatic guest creation), and it must learn to show it.
 *
 * Every refusal is HTTP 400 `{ error }` with no other detail.
 */
import { NextResponse } from 'next/server';
import { getEffectiveInstanceAccessSettings, type InstanceRegistrationMode } from '@lobbyforge/db';
import { peekSignInAttempts } from '@/lib/auth-throttle';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { burnFormToken, checkFormToken, honeypotTripped, issueFormToken } from './form';
import { maybeProbe } from './breaker';
import { externalProviderConfigured, resolveCaptchaSettings, type ResolvedCaptchaSettings } from './settings';
import { addressFailureCount, attackModeAutoUntil, recordSignInFailure } from './signals';
import { effectiveCaptchaProvider, verifyCaptcha } from './verify';
import {
  isExternalProvider,
  type CaptchaBody,
  type CaptchaProvider,
  type CaptchaRefusalCode,
  type CaptchaSurface,
  type CaptchaVerdict,
  type FormCaptchaSurface,
  type RecaptchaVersion,
  type SurfaceMode,
  type TurnstileAppearance,
} from './types';

export function captchaRefusal(code: CaptchaRefusalCode): NextResponse {
  return NextResponse.json({ error: code }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

function verdictRefusal(verdict: CaptchaVerdict): NextResponse | null {
  switch (verdict) {
    case 'ok':
      return null;
    case 'missing':
      return captchaRefusal('captcha_required');
    case 'invalid':
    case 'expired':
    case 'duplicate':
      return captchaRefusal('captcha_invalid');
    case 'unavailable':
    case 'misconfigured':
      return captchaRefusal('captcha_unavailable');
  }
}

/** Is attack mode on right now — by hand or automatically? */
export async function attackModeActive(settings: ResolvedCaptchaSettings): Promise<boolean> {
  return settings.attackModeManual || (await attackModeAutoUntil()) !== null;
}

/**
 * Does this surface need the challenge? `register` and `guest` follow their
 * own switch. `invite_register` can only ADD protection: on an
 * invite-only instance its own switch decides (an invite there is the gate,
 * and the switch trusts everyone who can create invites); anywhere else
 * (open — where `@everyone` may create unlimited invites — or when the mode
 * is unknown) an invite sign-up is challenged when EITHER `register` or
 * `invite_register` is on, so an invite never downgrades open sign-up.
 */
export function captchaSurfaceRequired(
  settings: ResolvedCaptchaSettings,
  surface: FormCaptchaSurface,
  registrationMode?: InstanceRegistrationMode | null
): boolean {
  if (settings.provider === 'none') return false;
  if (surface !== 'invite_register') return settings.surfaces[surface] === 'on';
  if (registrationMode === 'invite_only') return settings.surfaces.invite_register === 'on';
  return settings.surfaces.register === 'on' || settings.surfaces.invite_register === 'on';
}

/**
 * Sign-up (`register`, `invite_register`) and new guests (`guest`). Null
 * when the request may go on. `registrationMode` matters for
 * `invite_register` only (see `captchaSurfaceRequired`).
 */
export async function guardCaptchaSurface(
  req: Request,
  body: CaptchaBody,
  surface: FormCaptchaSurface,
  options: { registrationMode?: InstanceRegistrationMode | null } = {}
): Promise<NextResponse | null> {
  if (honeypotTripped(body.website)) return captchaRefusal('form_rejected');
  const settings = await resolveCaptchaSettings();
  // With the surface off the form token is not checked: a client that skips
  // the config (an API client) has none, so it could not stop a bot anyway,
  // and an old open tab must not be refused for its stale token.
  if (!captchaSurfaceRequired(settings, surface, options.registrationMode)) return null;
  if (!body.captchaToken?.trim()) return captchaRefusal('captcha_required');
  if (checkFormToken(body.formToken, surface) !== 'ok') return captchaRefusal('form_rejected');
  const refusal = verdictRefusal(
    await verifyCaptcha({ surface, token: body.captchaToken, provider: body.captchaProvider, req, settings })
  );
  if (refusal) return refusal;
  // Single use: burnt only on success, so a failed challenge can be retried
  // with the same form token.
  switch (await burnFormToken(body.formToken!)) {
    case 'ok':
      return null;
    case 'duplicate':
      return captchaRefusal('form_rejected');
    case 'unavailable':
      return captchaRefusal('captcha_unavailable');
  }
}

/** The instance's registration mode for the public config of `invite_register`; null when unknown (the stricter rule). */
async function registrationModeForConfig(): Promise<InstanceRegistrationMode | null> {
  if (isOfficialDeployment()) return null;
  try {
    return (await getEffectiveInstanceAccessSettings(getDb())).registrationMode;
  } catch {
    return null;
  }
}

export interface SignInCaptchaContext {
  email: string;
  /**
   * The request comes from a TRUSTED device for this account: a valid
   * `lf_device` entry that still holds against the account's current
   * password hash (`deviceClaimHolds`) and whose own failure bucket has not
   * tripped. A MAC-valid but stale entry does not count.
   */
  hasDeviceClaim: boolean;
}

/** Why a sign-in attempt needs the challenge, or null when it does not. */
export async function signInChallengeReason(
  req: Request,
  settings: ResolvedCaptchaSettings,
  context: SignInCaptchaContext
): Promise<'always' | 'attack_mode' | 'account' | 'address' | null> {
  const mode = settings.surfaces.login;
  if (settings.provider === 'none' || mode === 'off') return null;
  // The owner's own browser is not a bot — under `always` too.
  if (context.hasDeviceClaim) return null;
  if (mode === 'always') return 'always';
  if (await attackModeActive(settings)) return 'attack_mode';
  const threshold = settings.options.loginFailureThreshold;
  if (((await peekSignInAttempts(context.email)) ?? 0) >= threshold) return 'account';
  if ((await addressFailureCount(req)) >= threshold) return 'address';
  return null;
}

/**
 * Sign-in (`login`: /api/auth/login and /api/auth/desktop-session), BEFORE
 * the attempt is counted or anything is looked up. Null when the request
 * may go on. If the challenge itself cannot run (no session secret), the
 * sign-in is not blocked: the account and address limits still apply.
 */
export async function guardSignInCaptcha(
  req: Request,
  body: CaptchaBody,
  context: SignInCaptchaContext
): Promise<NextResponse | null> {
  if (honeypotTripped(body.website)) return captchaRefusal('form_rejected');
  const settings = await resolveCaptchaSettings();
  if (!(await signInChallengeReason(req, settings, context))) return null;
  if (!body.captchaToken?.trim()) return captchaRefusal('captcha_required');
  const verdict = await verifyCaptcha({
    surface: 'login',
    token: body.captchaToken,
    provider: body.captchaProvider,
    req,
    settings,
  });
  if (verdict === 'misconfigured') return null;
  return verdictRefusal(verdict);
}

/** A wrong email/password answer: feeds the address counter and attack mode. Never throws. */
export async function noteSignInFailure(req: Request): Promise<void> {
  await recordSignInFailure(req);
}

// ---- §4.1 public config ----------------------------------------------------

export interface PublicCaptchaConfig {
  surface: CaptchaSurface;
  required: boolean;
  mode: SurfaceMode;
  provider: CaptchaProvider;
  siteKey: string | null;
  options: { turnstileAppearance: TurnstileAppearance; recaptchaVersion: RecaptchaVersion };
  /** For register, invite_register and guest; null for login. */
  formToken: string | null;
}

export async function buildPublicCaptchaConfig(surface: CaptchaSurface): Promise<PublicCaptchaConfig> {
  const settings = await resolveCaptchaSettings();
  const off = settings.provider === 'none';
  const effective = await effectiveCaptchaProvider(settings);

  // §5: the lazy reachability probe, at most once per 60 s, in the
  // background (a slow provider must not slow this answer down).
  if (!off && isExternalProvider(settings.provider) && externalProviderConfigured(settings) && effective.fallback === null) {
    void maybeProbe(settings.provider, settings.secretKey!).catch(() => undefined);
  }

  let mode: SurfaceMode = off ? 'off' : settings.surfaces[surface];
  let required: boolean;
  if (off) required = false;
  else if (surface === 'login') required = mode === 'always' || (mode === 'adaptive' && (await attackModeActive(settings)));
  else {
    required = captchaSurfaceRequired(settings, surface, surface === 'invite_register' ? await registrationModeForConfig() : null);
    // `mode` reports what is in force: an invite sign-up on an open
    // instance follows `register` too (see captchaSurfaceRequired).
    mode = required ? 'on' : 'off';
  }

  return {
    surface,
    required,
    mode,
    provider: effective.provider,
    siteKey: isExternalProvider(effective.provider) ? settings.siteKey : null,
    options: {
      turnstileAppearance: settings.options.turnstileAppearance,
      recaptchaVersion: settings.options.recaptchaVersion,
    },
    formToken: surface === 'login' ? null : issueFormToken(surface),
  };
}
