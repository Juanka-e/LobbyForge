import { Bricolage_Grotesque } from 'next/font/google';

/**
 * The hub's display face. Loaded only by hub surfaces (the marketing and
 * marketplace layouts, the official sign-in pages) — the app shell keeps
 * Geist, so an instance's identity is unchanged. Exposed as
 * `--font-display`, which Tailwind's `font-display` reads.
 *
 * The variable font with its optical-size axis, as the design uses it: at
 * headline sizes the browser picks the tighter display cut (opsz follows
 * the font size), so a 76 px hero sets like the design instead of in the
 * wide text cut. `latin-ext` carries Turkish ğ ş ı İ, so headings never
 * fall back to another face mid-word.
 */
export const hubDisplayFont = Bricolage_Grotesque({
  subsets: ['latin', 'latin-ext'],
  axes: ['opsz'],
  variable: '--font-display',
  display: 'swap',
});
