'use client';

import Link from 'next/link';
import { Modal, ModalCancelButton } from '@/components/Modal';
import { useT } from '@/lib/i18n/client';
import EmailCodeEntry from './EmailCodeEntry';
import { needsVerification } from './email-status';
import { useEmailStatus } from './email-status-store';

export const CHANGE_EMAIL_HREF = '/settings/my-account#email';

/**
 * "Verify email" where the banner is not on screen (admin settings, the
 * hub's forms): the same code entry in a dialog. Once the status says
 * verified, the dialog says so and the locked control behind it unlocks.
 */
export default function VerifyEmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { status } = useEmailStatus({ enabled: open });
  const pending = status && needsVerification(status) ? status : null;
  const changing = Boolean(pending?.pendingChange);
  const target = pending?.pendingChange ?? pending?.email ?? '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('emailVerification.dialog.title')}
      size="md"
      footer={<ModalCancelButton onClick={onClose}>{t('common.close')}</ModalCancelButton>}
    >
      {pending ? (
        <div className="space-y-4 pb-2">
          <p className="text-pretty text-sm text-text-secondary">
            {t(changing ? 'emailVerification.banner.bodyChange' : 'emailVerification.banner.body', { email: target })}
          </p>
          <EmailCodeEntry
            purpose={changing ? 'change' : 'verify'}
            resend={changing ? null : pending.mailConfigured ? 'verify' : null}
            resendAvailableAt={pending.resendAvailableAt}
            showLabel
          />
          {!pending.mailConfigured ? (
            <p className="text-pretty text-sm text-text-secondary">{t('emailVerification.banner.mailOff')}</p>
          ) : null}
          <p className="text-sm text-text-secondary">
            <Link
              href={CHANGE_EMAIL_HREF}
              onClick={onClose}
              className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('emailVerification.action.changeEmail')}
            </Link>
          </p>
        </div>
      ) : (
        <p role="status" className="flex items-start gap-2 pb-2 text-sm text-text-primary">
          <span className="material-symbols-outlined text-[18px] text-success" aria-hidden>
            check_circle
          </span>
          <span>{t(status?.verified ? 'emailVerification.dialog.verified' : 'emailVerification.dialog.nothingToDo')}</span>
        </p>
      )}
    </Modal>
  );
}
