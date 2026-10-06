'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { authFlowStyles } from '@/app/login/auth-flow-styles';

type Phase = 'idle' | 'busy' | 'verified' | 'changed' | 'expired' | 'invalid' | 'taken' | 'rateLimited' | 'failed';

/** What the token POST answered, as a phase of the page. */
export function phaseFor(httpStatus: number, body: unknown): Phase {
  const record = typeof body === 'object' && body !== null ? (body as { error?: unknown; changed?: unknown }) : {};
  // The link of an email-change email lands here too: the change is applied.
  if (httpStatus >= 200 && httpStatus < 300) return record.changed === true ? 'changed' : 'verified';
  if (httpStatus === 429) return 'rateLimited';
  const code = record.error;
  if (code === 'expired') return 'expired';
  if (code === 'invalid_token' || code === 'invalid_code' || code === 'invalid_request') return 'invalid';
  // A new address that another account took in the meantime.
  if (code === 'email_taken') return 'taken';
  // Already verified (the link was used before): nothing is left to do.
  if (code === 'already_verified') return 'verified';
  return 'failed';
}

const TITLE: Record<Phase, string> = {
  idle: 'emailVerification.link.title',
  busy: 'emailVerification.link.title',
  verified: 'emailVerification.link.verifiedTitle',
  changed: 'emailVerification.link.changedTitle',
  expired: 'emailVerification.link.expiredTitle',
  invalid: 'emailVerification.link.invalidTitle',
  taken: 'emailVerification.link.title',
  rateLimited: 'emailVerification.link.title',
  failed: 'emailVerification.link.title',
};

const LEAD: Partial<Record<Phase, string>> = {
  verified: 'emailVerification.link.verifiedBody',
  changed: 'emailVerification.link.changedBody',
  expired: 'emailVerification.link.expiredBody',
  invalid: 'emailVerification.link.invalidBody',
};

/**
 * The confirmation page's one button. GET showed this page; only this
 * POST uses the token (EMAIL.md §4.1).
 */
export default function VerifyEmailConfirm({
  token,
  official,
  continueHref,
  signedIn,
}: {
  token: string | null;
  official: boolean;
  continueHref: '/home' | '/lobby' | '/login';
  signedIn: boolean;
}) {
  const t = useT();
  const styles = authFlowStyles(official);
  const [phase, setPhase] = useState<Phase>(token ? 'idle' : 'invalid');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const firstRender = useRef(true);

  // A result replaces the button: move focus to its heading so it is read out.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (phase !== 'busy') headingRef.current?.focus();
  }, [phase]);

  async function verify() {
    if (!token || phase === 'busy') return;
    setPhase('busy');
    try {
      const response = await fetch('/api/auth/email/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body: unknown = await response.json().catch(() => null);
      setPhase(phaseFor(response.status, body));
    } catch {
      setPhase('failed');
    }
  }

  const continueLabel = signedIn ? t('emailVerification.link.continue') : t('auth.login.signIn');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {phase === 'verified' || phase === 'changed' ? (
          <span className="material-symbols-outlined text-[32px] text-success" aria-hidden>
            verified
          </span>
        ) : phase === 'expired' || phase === 'invalid' ? (
          <span className="material-symbols-outlined text-[32px] text-danger" aria-hidden>
            link_off
          </span>
        ) : (
          <span className="material-symbols-outlined text-[32px] text-primary" aria-hidden>
            mark_email_read
          </span>
        )}
        <h1 ref={headingRef} tabIndex={-1} className={`${styles.title} outline-none`}>
          {t(TITLE[phase])}
        </h1>
        <p className={styles.lead}>{t(LEAD[phase] ?? 'emailVerification.link.body')}</p>
      </div>

      {phase === 'rateLimited' || phase === 'failed' || phase === 'taken' ? (
        <p role="alert" className={styles.alert}>
          {t(
            phase === 'rateLimited'
              ? 'emailVerification.error.rateLimited'
              : phase === 'taken'
                ? 'emailVerification.change.error.taken'
                : 'emailVerification.link.failed'
          )}
        </p>
      ) : null}

      {phase === 'idle' || phase === 'busy' || phase === 'rateLimited' || phase === 'failed' ? (
        <button type="button" onClick={() => void verify()} disabled={phase === 'busy'} aria-busy={phase === 'busy'} className={styles.submit}>
          {phase === 'busy' ? t('emailVerification.link.verifying') : t('emailVerification.link.button')}
        </button>
      ) : (
        <Link href={continueHref} className={phase === 'verified' || phase === 'changed' ? styles.submit : styles.secondary}>
          {continueLabel}
        </Link>
      )}

      <p className="text-pretty text-[13px] text-text-muted">{t('emailVerification.link.noSignIn')}</p>
    </div>
  );
}
