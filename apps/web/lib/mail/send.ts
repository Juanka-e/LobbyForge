/**
 * Sending (docs/EMAIL.md §2.3). The entry point is
 * `sendMail({ to, template, locale, vars })`.
 *
 *   - every address passes zod validation before nodemailer sees it;
 *   - the instance-wide `mailDailyLimit` refuses sends at 100%
 *     (`mail_quota`); Doctor warns at 80%;
 *   - failures are counted for Doctor and logged with the address masked
 *     (never the server's text, which can echo it);
 *   - `dispatchMail` is the fire-and-forget form for sign-up and the user
 *     routes: the request never waits for SMTP (§2.3 "sign-up never blocks
 *     on mail").
 *
 * Server-only.
 */
import { getInstanceSetupStatus } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { resolveMailSettings, type ResolvedMailSettings } from './settings';
import { countSend, recordMailFailure, recordMailSuccess, sentToday } from './stats';
import { maskEmail, mailLocale, renderMail, type MailTemplateVars } from './templates';
import { getPooledTransport, type MailTransport, type SmtpConfig } from './transport';
import { EmailAddressSchema, type MailOutcome, type MailTemplate } from './types';
import type { SmtpTargetContext } from './host-rules';

export type SendMailError = 'mail_unavailable' | 'mail_quota' | 'invalid_recipient';

export interface SendMailInput {
  to: string;
  template: MailTemplate;
  /** The recipient's `users.locale`; falls back to the instance default. */
  locale?: string | null;
  vars?: Omit<MailTemplateVars, 'instanceName'>;
}

export type SendMailResult = { ok: true; messageId: string | null } | { ok: false; error: SendMailError; outcome?: MailOutcome };

export function smtpTargetContext(): SmtpTargetContext {
  return { production: process.env.NODE_ENV === 'production', official: isOfficialDeployment() };
}

/** `Name <addr>` or a bare address → the address part, validated; null when unusable. */
export function parseFromAddress(from: string | null | undefined): { header: string; address: string } | null {
  if (!from) return null;
  let trimmed = from.trim();
  // An env file value may keep its quotes: "LobbyForge <no-reply@example.org>".
  if (trimmed.length > 1 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (/[\r\n]/.test(trimmed) || trimmed.length > 320) return null;
  const angle = /^(.*)<([^<>]+)>$/.exec(trimmed);
  const address = (angle ? angle[2]! : trimmed).trim();
  const parsed = EmailAddressSchema.safeParse(address);
  if (!parsed.success) return null;
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, '$1');
    if (/["\\]/.test(name)) return null;
    return { header: name ? `"${name}" <${parsed.data}>` : parsed.data, address: parsed.data };
  }
  return { header: parsed.data, address: parsed.data };
}

/** The SMTP part of the effective settings, when complete. */
export function smtpConfigFrom(settings: ResolvedMailSettings): SmtpConfig | null {
  if (!settings.transportConfigured || !settings.host || settings.port === null || !settings.security) return null;
  return {
    provider: settings.provider,
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    password: settings.password,
  };
}

/** Why a send would be refused right now, or null. Cheap: no network. */
export async function mailAvailability(settings?: ResolvedMailSettings): Promise<'mail_unavailable' | 'mail_quota' | null> {
  const resolved = settings ?? (await resolveMailSettings());
  if (!smtpConfigFrom(resolved) || !parseFromAddress(resolved.from)) return 'mail_unavailable';
  if (resolved.dailyLimit && (await sentToday()) >= resolved.dailyLimit) return 'mail_quota';
  return null;
}

export async function instanceDisplayName(): Promise<string> {
  try {
    return (await getInstanceSetupStatus(getDb())).instanceName || 'LobbyForge';
  } catch {
    return 'LobbyForge';
  }
}

/** The link base: the configured public origin, never a request's Host header. Null when none is configured. */
export function appOrigin(): string | null {
  for (const value of [process.env.LOBBYFORGE_APP_ORIGIN, process.env.NEXT_PUBLIC_BASE_URL]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** `<origin>/<path>?t=<token>`, or null without a configured origin (the email then carries the code only). */
export function appLink(path: '/verify-email' | '/reset-password', token: string): string | null {
  const origin = appOrigin();
  return origin ? `${origin}${path}?t=${encodeURIComponent(token)}` : null;
}

/** Render and send through a given transport. Shared by sendMail and the admin test. */
export async function deliverMail(
  transport: MailTransport,
  input: { from: string; to: string; template: MailTemplate; locale: string; vars: MailTemplateVars }
): Promise<{ ok: true; messageId: string | null } | { ok: false; outcome: MailOutcome; permanent: boolean }> {
  const rendered = renderMail(input.template, input.locale, input.vars);
  const result = await transport.send({
    from: input.from,
    to: input.to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: { 'Auto-Submitted': 'auto-generated', 'Content-Language': rendered.locale },
  });
  if (result.ok) return result;
  const { ok: _ok, permanent, ...outcome } = result;
  return { ok: false, outcome, permanent };
}

export async function sendMail(input: SendMailInput, options: { ignoreQuota?: boolean } = {}): Promise<SendMailResult> {
  const recipient = EmailAddressSchema.safeParse(input.to);
  if (!recipient.success) return { ok: false, error: 'invalid_recipient' };
  const settings = await resolveMailSettings();
  const config = smtpConfigFrom(settings);
  const from = parseFromAddress(settings.from);
  if (!config || !from) return { ok: false, error: 'mail_unavailable', outcome: { result: 'not_configured' } };

  if (!options.ignoreQuota && settings.dailyLimit) {
    // Reserve before sending, so concurrent sends cannot all slip under the limit.
    const total = await countSend();
    if (total > settings.dailyLimit) return { ok: false, error: 'mail_quota' };
  } else {
    await countSend();
  }

  const built = await getPooledTransport(config, smtpTargetContext());
  if (!built.ok) {
    await recordMailFailure(built.outcome);
    console.error(`[mail] ${input.template} to ${JSON.stringify(maskEmail(recipient.data))} not sent: ${built.outcome.result}${built.outcome.detail ? `/${built.outcome.detail}` : ''}`);
    return { ok: false, error: 'mail_unavailable', outcome: built.outcome };
  }
  const result = await deliverMail(built.transport, {
    from: from.header,
    to: recipient.data,
    template: input.template,
    locale: mailLocale(input.locale),
    vars: { ...input.vars, instanceName: await instanceDisplayName() },
  });
  if (result.ok) {
    await recordMailSuccess();
    return result;
  }
  await recordMailFailure(result.outcome);
  console.error(`[mail] ${input.template} to ${JSON.stringify(maskEmail(recipient.data))} failed: ${result.outcome.result}${result.outcome.detail ? `/${result.outcome.detail}` : ''}`);
  return { ok: false, error: 'mail_unavailable', outcome: result.outcome };
}

/** Fire and forget: the caller never waits for SMTP, and nothing it does can throw from here. */
export function dispatchMail(input: SendMailInput): void {
  void sendMail(input).catch((error: unknown) => {
    console.error(`[mail] ${input.template} send crashed`, JSON.stringify((error as Error)?.message ?? String(error)));
  });
}
