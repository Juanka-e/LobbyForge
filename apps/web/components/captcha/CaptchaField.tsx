'use client';

import { ALTCHA_HEIGHT } from './AltchaChallenge';
import { CaptchaChallenge } from './CaptchaChallenge';
import { ChallengeLoadError, ChallengeLoading } from './ChallengeStatus';
import { Honeypot } from './Honeypot';
import type { CaptchaGate } from './useCaptchaGate';

/**
 * Bot protection inside a form: the honeypot always, and the challenge
 * when the config (or the server's `captcha_required`) calls for one.
 * Place it just above the submit button.
 */
export function CaptchaField({ gate, className }: { gate: CaptchaGate; className?: string }) {
  return (
    <>
      <Honeypot {...gate.honeypot} />
      {gate.showChallenge ? (
        <CaptchaChallenge {...gate.challengeProps} className={className} />
      ) : gate.expectingChallenge && gate.configStatus === 'error' ? (
        <ChallengeLoadError onRetry={() => void gate.refreshConfig()} />
      ) : gate.expectingChallenge ? (
        <ChallengeLoading minHeight={ALTCHA_HEIGHT} />
      ) : null}
    </>
  );
}
