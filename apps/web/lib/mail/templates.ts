/**
 * Email templates (docs/EMAIL.md §2.3): plain text plus simple HTML, built
 * from `messages/<locale>/email.json` in the recipient's language (their
 * `users.locale`, else the instance default, else English).
 *
 *   - no remote images, no tracking pixels, no external CSS — inline styles;
 *   - the code is never in the subject line (lock-screen previews);
 *   - every value is HTML-escaped; the link is the only URL, built from the
 *     configured app origin, never from a request's Host header;
 *   - minimal data: no display name, only the address, the code and the link.
 *
 * Server-only (reads the catalogues from disk).
 */
import { translatorFor, getDiscovery } from '@/lib/i18n/catalogue';
import { SOURCE_LOCALE, negotiateLocale } from '@/lib/i18n/core';
import { readLocaleCookie } from '@/lib/i18n/locale-cookie';
import type { MailTemplate } from './types';

export interface MailTemplateVars {
  instanceName: string;
  /** The 6-digit code (verify, change-confirm, reset). */
  code?: string;
  /** The confirmation link (verify, change-confirm, reset), when an app origin is configured. */
  link?: string | null;
  /** The new address, masked (change-notice). */
  email?: string;
  /** Code validity in minutes. */
  codeMinutes?: number;
  /** Link validity in hours. */
  linkHours?: number;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
  locale: string;
}

const PREFIX: Record<MailTemplate, string> = {
  verify: 'email.verify',
  'change-confirm': 'email.changeConfirm',
  'change-notice': 'email.changeNotice',
  reset: 'email.reset',
  test: 'email.test',
};

const WITH_CODE: ReadonlySet<MailTemplate> = new Set(['verify', 'change-confirm', 'reset']);

/** The language to write in: the given one, else LOBBYFORGE_DEFAULT_LOCALE, else English — whichever is installed. */
export function mailLocale(userLocale: string | null | undefined): string {
  const codes = getDiscovery().locales.map((locale) => locale.code);
  const pick = (value: string | null | undefined) => (value ? codes.find((code) => code.toLowerCase() === value.trim().toLowerCase()) : undefined);
  return pick(userLocale) ?? pick(process.env.LOBBYFORGE_DEFAULT_LOCALE) ?? SOURCE_LOCALE;
}

/** The language a request's pages render in: the `lf_locale` choice → Accept-Language → the instance default. */
export function requestLocale(req: Request): string {
  const codes = getDiscovery().locales.map((locale) => locale.code);
  const saved = readLocaleCookie(req.headers.get('cookie'), codes);
  return saved ?? negotiateLocale(req.headers.get('accept-language'), codes, mailLocale(null));
}

/**
 * The language of an email the recipient asked for themselves (sign-up,
 * resend, change, forgot password): their saved `users.locale` when it is
 * an explicit choice (anything but the column default `en`), else the
 * language they are using right now — what the request's pages render in.
 * `users.locale` alone would be English for nearly everyone: nothing in
 * the UI writes it yet.
 */
export function preferredMailLocale(req: Request, userLocale: string | null | undefined): string {
  if (userLocale && userLocale !== SOURCE_LOCALE) return mailLocale(userLocale);
  return requestLocale(req);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "john@example.org" → "j***@example.org" (the change notice to the OLD address; and logs). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function renderMail(template: MailTemplate, locale: string, vars: MailTemplateVars): RenderedMail {
  const t = translatorFor(locale);
  const p = PREFIX[template];
  const instance = vars.instanceName;
  const minutes = vars.codeMinutes ?? 15;
  const hours = vars.linkHours ?? 24;
  const subject = t(`${p}.subject`, { instance });
  const heading = t(`${p}.heading`, { instance });
  const intro = t(`${p}.intro`, { instance, email: vars.email ?? '' });
  const withCode = WITH_CODE.has(template) && Boolean(vars.code);
  const link = withCode && vars.link ? vars.link : null;

  const lines: string[] = [t('email.common.greeting'), '', heading, '', intro, ''];
  if (withCode) {
    lines.push(t('email.common.codeLabel'), '', `    ${vars.code}`, '', t('email.common.codeExpiry', { minutes }), '');
    if (link) lines.push(t('email.common.linkIntro'), link, t('email.common.linkExpiry', { hours }), '');
  }
  if (template === 'change-notice') lines.push(t(`${p}.notYou`, { instance }), '');
  else if (template !== 'test') lines.push(t(`${p}.ignore`, { instance }), '');
  if (withCode) lines.push(t('email.common.neverShare', { instance }));
  lines.push(t('email.common.automated', { instance }));
  const text = lines.join('\n');

  const dir = getDiscovery().locales.find((info) => info.code === locale)?.dir ?? 'ltr';
  const e = escapeHtml;
  const parts: string[] = [];
  parts.push(`<p style="margin:0 0 16px">${e(t('email.common.greeting'))}</p>`);
  parts.push(`<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${e(heading)}</h1>`);
  parts.push(`<p style="margin:0 0 16px">${e(intro)}</p>`);
  if (withCode) {
    parts.push(`<p style="margin:0 0 8px">${e(t('email.common.codeLabel'))}</p>`);
    parts.push(
      `<p style="margin:0 0 8px;font-family:Consolas,Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:6px">${e(vars.code!)}</p>`
    );
    parts.push(`<p style="margin:0 0 16px;color:#555">${e(t('email.common.codeExpiry', { minutes }))}</p>`);
    if (link) {
      parts.push(`<p style="margin:0 0 8px">${e(t('email.common.linkIntro'))}</p>`);
      parts.push(
        `<p style="margin:0 0 8px"><a href="${e(link)}" style="display:inline-block;padding:10px 16px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px">${e(t(`${p}.button`))}</a></p>`
      );
      parts.push(`<p style="margin:0 0 16px;color:#555;word-break:break-all">${e(link)}<br>${e(t('email.common.linkExpiry', { hours }))}</p>`);
    }
  }
  if (template === 'change-notice') parts.push(`<p style="margin:0 0 16px">${e(t(`${p}.notYou`, { instance }))}</p>`);
  else if (template !== 'test') parts.push(`<p style="margin:0 0 16px;color:#555">${e(t(`${p}.ignore`, { instance }))}</p>`);
  const footer = [withCode ? t('email.common.neverShare', { instance }) : null, t('email.common.automated', { instance })].filter(Boolean) as string[];
  parts.push(`<p style="margin:24px 0 0;font-size:12px;color:#777">${footer.map(e).join('<br>')}</p>`);
  const html =
    `<!doctype html><html lang="${e(locale)}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;line-height:1.5">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">${parts.join('')}</div></body></html>`;

  return { subject, text, html, locale };
}
