'use client';

import Link from 'next/link';
import { useEffect, useId, useRef } from 'react';
import { useT } from '@/lib/i18n/client';
import EmailCodeEntry from './EmailCodeEntry';
import { isRestricted, needsVerification, type EmailStatus } from './email-status';
import { VERIFY_EMAIL_REQUEST_EVENT, useEmailStatus } from './email-status-store';
import { CHANGE_EMAIL_HREF } from './VerifyEmailDialog';

/**
 * "Verify your email" — for a signed-in account whose address is not
 * verified while the instance asks for it (`optional` or `required`).
 *
 * It holds the code entry itself, "Resend" with its countdown and a way to
 * change the address. In `required` mode a restricted account is told
 * plainly what stays locked until it verifies. Every "Verify email" button
 * elsewhere on the page scrolls here and focuses the code field.
 *
 * - `lobby`: a strip across the top of the centre column, above whatever
 *   the column shows (chat, voice, a DM, activities) — the column stays the
 *   one work surface, it only gets shorter.
 * - `hub`: a strip under the official hub's header.
 */
export default function EmailVerificationBanner({
  enabled,
  initialStatus,
  variant,
}: {
  /** Signed in with an account that can have an address (not a guest). */
  enabled: boolean;
  /** A status the server already rendered: the banner is then in the first paint. */
  initialStatus?: EmailStatus | null;
  variant: 'lobby' | 'hub';
}) {
  const t = useT();
  const titleId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { status } = useEmailStatus({ enabled, initial: initialStatus });
  const visible = needsVerification(status);

  useEffect(() => {
    if (!visible) return;
    function onRequest(event: Event) {
      event.preventDefault();
      rootRef.current?.scrollIntoView?.({ block: 'nearest' });
      inputRef.current?.focus();
    }
    window.addEventListener(VERIFY_EMAIL_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(VERIFY_EMAIL_REQUEST_EVENT, onRequest);
  }, [visible]);

  if (!status || !visible) return null;

  const restricted = isRestricted(status);
  const changing = Boolean(status.pendingChange);
  const target = status.pendingChange ?? status.email ?? '';
  const tone = restricted ? 'border-ember/40 bg-ember/10' : 'border-primary/25 bg-primary/10';
  const frame =
    variant === 'lobby'
      ? // The mobile menu button is fixed over the top-left corner below md.
        `shrink-0 border-b py-3 pl-16 pr-4 sm:pr-6 md:pl-6 ${tone}`
      : `border-b ${tone}`;

  const content = (
    <div className="flex gap-3">
      <span className={`material-symbols-outlined mt-0.5 text-[20px] ${restricted ? 'text-ember' : 'text-primary'}`} aria-hidden>
        {restricted ? 'lock' : 'mark_email_unread'}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-sm font-semibold text-text-primary">
          {t(restricted ? 'emailVerification.banner.titleRestricted' : 'emailVerification.banner.title')}
        </h2>
        <p className="mt-0.5 text-pretty text-sm text-text-secondary">
          {t(changing ? 'emailVerification.banner.bodyChange' : 'emailVerification.banner.body', { email: target })}
        </p>
        {restricted ? (
          <p className="mt-1 text-pretty text-sm text-text-primary">
            {t(variant === 'hub' ? 'emailVerification.banner.lockedHub' : 'emailVerification.banner.locked')}
          </p>
        ) : null}
        {!status.mailConfigured && !changing ? (
          <p className="mt-1 text-pretty text-sm text-text-secondary">{t('emailVerification.banner.mailOff')}</p>
        ) : null}
        <div className="mt-2.5">
          <EmailCodeEntry
            purpose={changing ? 'change' : 'verify'}
            resend={changing || !status.mailConfigured ? null : 'verify'}
            resendAvailableAt={status.resendAvailableAt}
            inputRef={inputRef}
            extraActions={
              <Link
                href={CHANGE_EMAIL_HREF}
                className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t(changing ? 'emailVerification.action.otherAddress' : 'emailVerification.action.changeEmail')}
              </Link>
            }
          />
        </div>
      </div>
    </div>
  );

  return (
    <section ref={rootRef} aria-labelledby={titleId} data-email-banner={variant} className={frame}>
      {variant === 'hub' ? <div className="mx-auto w-full max-w-[1240px] px-5 py-3 sm:px-8 xl:px-0">{content}</div> : content}
    </section>
  );
}
