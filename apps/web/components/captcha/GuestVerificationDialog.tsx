'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Modal } from '@/components/Modal';
import { SIGN_IN_PATH } from '@/lib/hub-routes';
import { useT } from '@/lib/i18n/client';
import { currentPagePath, signInHref } from '@/lib/sign-in-return';
import { CaptchaField } from './CaptchaField';
import { guestFailureMessage } from './guest-failure';
import { useCaptchaGate } from './useCaptchaGate';

export type GuestIdentity = { gid: string; uid: string | null; name: string };

/**
 * The challenge for pages that create a guest on their own — the lobby's
 * voice provider and the voice room — once `POST /api/auth/guest` refused
 * with a captcha code (docs/CAPTCHA.md §6).
 *
 * A dialog rather than a redirect: the person keeps the page they opened
 * (the room link, the lobby), ALTCHA solves while they read, and one press
 * of "Continue" finishes. Signing in with an account stays one link away,
 * and closing the dialog leaves the page with a way to open it again —
 * never a loop of automatic retries and never a dead control.
 */
export function GuestVerificationDialog({
  open,
  body,
  onVerified,
  onDismiss,
}: {
  open: boolean;
  /** The guest request's own fields (`displayNameSeed`, `inviteCode`). */
  body?: Record<string, unknown>;
  onVerified: (guest: GuestIdentity) => void;
  onDismiss: () => void;
}) {
  // Mounted only while open: every opening fetches a fresh config and formToken.
  if (!open) return null;
  return <GuestVerificationPanel body={body} onVerified={onVerified} onDismiss={onDismiss} />;
}

function isGuest(value: unknown): value is GuestIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const guest = value as Record<string, unknown>;
  return typeof guest.gid === 'string' && typeof guest.name === 'string' && (guest.uid === null || typeof guest.uid === 'string');
}

function GuestVerificationPanel({
  body,
  onVerified,
  onDismiss,
}: {
  body?: Record<string, unknown>;
  onVerified: (guest: GuestIdentity) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const formId = useId();
  const gate = useCaptchaGate({ surface: 'guest', required: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signing in instead brings the person back to this lobby or room.
  const [signInLink, setSignInLink] = useState(SIGN_IN_PATH);
  useEffect(() => setSignInLink(signInHref(currentPagePath())), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await gate.submit((fields) =>
      fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...fields }),
      })
    );
    if (result.kind === 'blocked') {
      setError(t(result.messageKey));
      setBusy(false);
      return;
    }
    if (result.kind === 'network') {
      setError(t('captcha.error.network'));
      setBusy(false);
      return;
    }
    const guest = result.body.guest;
    if (!result.response.ok || !isGuest(guest)) {
      setError(guestFailureMessage(t, result.response.status, result.body));
      setBusy(false);
      return;
    }
    onVerified(guest);
  }

  return (
    <Modal
      open
      onClose={onDismiss}
      title={t('captcha.guest.title')}
      description={t('captcha.guest.description')}
      size="sm"
      disableBackdropClose
      footer={
        <div className="flex w-full flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <a
            href={signInLink}
            className="rounded-sm text-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('captcha.guest.signIn')}
          </a>
          <button
            type="submit"
            form={formId}
            disabled={busy}
            aria-busy={busy}
            className="rounded-lg bg-primary-container px-5 py-2.5 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? t('captcha.guest.working') : t('captcha.guest.continue')}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="relative grid gap-3 pb-4" noValidate>
        <CaptchaField gate={gate} />
        {error ? (
          <p role="alert" className="text-pretty text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
