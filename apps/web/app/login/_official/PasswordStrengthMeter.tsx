'use client';

import tones from '@/app/(marketing)/_components/hub-tones.module.css';
import { useT } from '@/lib/i18n/client';
import { passwordStrength, type PasswordStrengthLevel } from '@/lib/password-strength';

const STRENGTH_TEXT: Record<PasswordStrengthLevel, string> = {
  empty: 'auth.login.passwordPlaceholderNew',
  tooShort: 'auth.official.strength.tooShort',
  fair: 'auth.official.strength.fair',
  strong: 'auth.official.strength.strong',
  veryStrong: 'auth.official.strength.veryStrong',
};

/** Meter colours. The words carry the meaning too — colour is never the only cue. */
function strengthInk(level: PasswordStrengthLevel): string {
  if (level === 'tooShort') return tones.danger;
  if (level === 'fair') return 'text-ember';
  if (level === 'strong' || level === 'veryStrong') return tones.success;
  return 'text-text-muted';
}

function strengthFill(level: PasswordStrengthLevel): string {
  if (level === 'tooShort') return tones.dangerFill;
  if (level === 'fair') return 'bg-ember';
  return tones.successFill;
}

/**
 * The four-bar password meter and its sentence, for every form that sets
 * a new password (sign-up, password reset). Advice, not a gate: the only
 * rule is the minimum length (`lib/password-strength.ts`). Put it inside
 * the field (`PasswordField`'s children) and point the input's
 * `aria-describedby` at `id`.
 */
export default function PasswordStrengthMeter({ id, password }: { id: string; password: string }) {
  const t = useT();
  const strength = passwordStrength(password);
  return (
    <>
      <span aria-hidden className="flex gap-1.5">
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={`h-1 flex-1 rounded ${bar <= strength.score ? strengthFill(strength.level) : 'bg-border-subtle'}`}
          />
        ))}
      </span>
      <p id={id} aria-live="polite" className={`text-[13px] ${strengthInk(strength.level)}`}>
        {t(STRENGTH_TEXT[strength.level])}
      </p>
    </>
  );
}
