'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { isRestricted, RESTRICTED_ACTION_KEYS, type RestrictedAction } from './email-status';
import { handleEmailUnverified, requestVerificationFocus, useEmailStatus } from './email-status-store';
import VerifyEmailDialog from './VerifyEmailDialog';

export { handleEmailUnverified };

/**
 * The one way every restricted control (docs/EMAIL.md §4.2) deals with
 * email verification:
 *
 *   const lock = useEmailRestriction();
 *   <button disabled={lock.restricted || …}>…</button>
 *   {lock.restricted || refused ? <EmailUnverifiedNotice action="createInvite" /> : null}
 *   …
 *   if (handleEmailUnverified(response.status, body)) { setRefused(true); return; }
 *
 * The status disables the control up front; a 403 `email_unverified` that
 * still arrives (the status was stale, another tab) is explained instead
 * of showing the route's English error.
 */
export function useEmailRestriction({ enabled = true }: { enabled?: boolean } = {}) {
  const { status, loaded } = useEmailStatus({ enabled });
  return { restricted: isRestricted(status), status, loaded };
}

/**
 * "Verify email": focus the banner's code field when the banner is on
 * screen, otherwise open the verify dialog. Render `dialog` somewhere in
 * the component.
 */
export function useVerifyEmailAction(): { request: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const request = useCallback(() => {
    if (!requestVerificationFocus()) setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { request, dialog: open ? <VerifyEmailDialog open onClose={close} /> : null };
}

/**
 * The friendly line a locked control shows: what needs a verified email,
 * and a "Verify email" button.
 */
export default function EmailUnverifiedNotice({
  action,
  className = '',
  compact = false,
}: {
  action: RestrictedAction;
  className?: string;
  /** One line, no frame — for tight spots such as the voice footer. */
  compact?: boolean;
}) {
  const t = useT();
  const verify = useVerifyEmailAction();
  return (
    <div
      data-email-unverified-notice={action}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-text-primary ${
        compact ? '' : 'rounded-lg border border-ember/40 bg-ember/10 px-3 py-2'
      } ${className}`}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <span className="material-symbols-outlined text-[18px] text-ember" aria-hidden>
          lock
        </span>
        <span className="min-w-0 text-pretty">{t(RESTRICTED_ACTION_KEYS[action])}</span>
      </span>
      <button
        type="button"
        onClick={verify.request}
        className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t('emailVerification.action.verify')}
      </button>
      {verify.dialog}
    </div>
  );
}
