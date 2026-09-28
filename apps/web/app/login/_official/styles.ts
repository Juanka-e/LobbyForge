import { focusRing } from '@/app/(marketing)/_components/styles';

/** Text inputs on the official sign-in pages (the design's 48 px field). */
export const authInput =
  'h-12 w-full rounded-xl border border-border-strong bg-surface px-3.5 text-[15px] text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary';

export const authLabel = 'text-sm font-medium text-text-primary';

/** The 50 px accent submit button. */
export const authSubmit = `inline-flex h-[50px] w-full items-center justify-center rounded-[14px] bg-primary text-base font-semibold text-on-primary transition-[filter] hover:brightness-110 disabled:cursor-wait disabled:opacity-70 ${focusRing}`;

/** The 50 px outlined alternative (Google, connect by address). */
export const authAlternative = `inline-flex h-[50px] w-full items-center justify-center gap-2.5 rounded-[14px] border border-border-strong text-[15px] text-text-primary transition-colors hover:bg-surface-raised ${focusRing}`;

export const authLink = `rounded-sm font-medium text-primary underline-offset-4 hover:underline ${focusRing}`;
