import { authInput, authLabel, authLink, authSubmit } from './_official/styles';

/**
 * Class strings for the account-recovery pages (`/forgot-password`,
 * `/reset-password`, `/verify-email`). They take the look of the sign-in
 * they belong to: the official hub's (48 px fields, accent button) or a
 * self-hosted community's (`LoginForm`).
 */
export interface AuthFlowStyles {
  title: string;
  lead: string;
  label: string;
  input: string;
  submit: string;
  secondary: string;
  link: string;
  alert: string;
  success: string;
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const OFFICIAL: AuthFlowStyles = {
  title: 'text-balance text-[30px] font-semibold tracking-[-0.01em] text-text-primary',
  lead: 'text-pretty text-[15px] text-text-secondary',
  label: authLabel,
  input: authInput,
  submit: authSubmit,
  secondary: `inline-flex h-[50px] w-full items-center justify-center gap-2.5 rounded-[14px] border border-border-strong text-[15px] font-medium text-text-primary transition-colors hover:bg-surface-raised ${focusRing}`,
  link: authLink,
  alert: 'rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-pretty text-sm text-text-primary',
  success: 'rounded-xl border border-success/40 bg-success/10 px-3.5 py-2.5 text-pretty text-sm text-text-primary',
};

const SELF_HOST: AuthFlowStyles = {
  title: 'text-balance text-xl font-semibold text-text-primary',
  lead: 'text-pretty text-sm text-text-secondary',
  label: 'text-sm font-medium text-text-secondary',
  input: 'auth-input',
  submit: `inline-flex w-full items-center justify-center rounded-lg bg-primary-container px-4 py-2.5 font-semibold text-on-primary-container transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`,
  secondary: `inline-flex w-full items-center justify-center rounded-lg border border-border-strong bg-surface px-4 py-2.5 font-semibold text-text-primary transition-colors hover:bg-surface-container ${focusRing}`,
  link: `rounded-sm font-medium text-primary underline-offset-4 hover:underline ${focusRing}`,
  alert: 'rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-pretty text-sm text-text-primary',
  success: 'rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-pretty text-sm text-text-primary',
};

export function authFlowStyles(official: boolean): AuthFlowStyles {
  return official ? OFFICIAL : SELF_HOST;
}
