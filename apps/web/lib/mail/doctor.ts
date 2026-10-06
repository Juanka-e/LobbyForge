/**
 * Doctor checks for email (docs/EMAIL.md §6), category `services`:
 *
 *   critical  mail_transport      verification `required` without a working transport configuration
 *   critical  mail_password       the stored SMTP password cannot be decrypted (the session secret changed)
 *   warning   mail_last_test      the last test failed (or `required` with a configuration never tested)
 *   warning   mail_send_failures  sends failed in the last day (auth failures called out);
 *                                 CRITICAL in `required` mode while nothing has gone out since the last failure
 *   warning   mail_daily_limit    today's sends are at 80% of mailDailyLimit or more
 *   warning   mail_env / mail_settings  invalid environment values / the row could not be read
 *   hint      mail_port_25        port 25 ("blocked on most VPS")
 *   hint      mail_dns            the From domain has no SPF TXT or no _dmarc record
 *   hint      mail_gmail          the Gmail preset in production
 *   info      mail                everything else: provider and verification mode
 *
 * A "hint" is `ok: false` at level INFO: it shows, but never makes the
 * report unhealthy. `buildMailChecks` is pure (the caller gathers the
 * facts); `collectMailChecks` gathers them — the DNS lookups have a 2 s
 * timeout and are skipped for local hosts.
 */
import { AlertLevel, DoctorCategory, type DoctorCheck } from '@lobbyforge/core';
import { getMailProvider } from './providers';
import type { MailFailureStats } from './stats';
import type { ResolvedMailSettings } from './settings';
import type { EmailVerificationMode, MailProviderSetting } from './types';

export interface MailDoctorFacts {
  provider: MailProviderSetting;
  mode: EmailVerificationMode;
  transportConfigured: boolean;
  passwordState: ResolvedMailSettings['passwordState'];
  port: number | null;
  lastTestResult: string | null;
  invalidEnv: string[];
  settingsLoaded: boolean;
  failures: MailFailureStats;
  sentToday: number;
  dailyLimit: number | null;
  production: boolean;
  /** null = not looked up (no From domain, a local host, or the lookup failed). */
  dns: { domain: string; spf: boolean | null; dmarc: boolean | null } | null;
}

function check(id: string, ok: boolean, level: AlertLevel, message: string, detail?: Record<string, unknown>): DoctorCheck {
  return { id, category: DoctorCategory.SERVICES, ok, level, message, ...(detail ? { detail } : {}) };
}

function providerName(provider: MailProviderSetting): string {
  return provider === 'none' ? 'none' : getMailProvider(provider)?.name ?? provider;
}

export function buildMailChecks(facts: MailDoctorFacts): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const name = providerName(facts.provider);

  if (facts.invalidEnv.length > 0) {
    out.push(check('mail_env', false, AlertLevel.WARNING, `Ignored invalid email settings in the environment: ${facts.invalidEnv.join(', ')}.`, { variables: facts.invalidEnv }));
  }
  if (!facts.settingsLoaded) {
    out.push(check('mail_settings', false, AlertLevel.WARNING, 'Email settings could not be read; no mail is sent and verification restricts nobody until the database answers.'));
  }

  if (facts.mode === 'required' && !facts.transportConfigured) {
    out.push(
      check(
        'mail_transport',
        false,
        AlertLevel.CRITICAL,
        'Email verification is required but no working mail transport is configured: new accounts cannot verify and stay restricted. Configure mail in Admin → Settings → Email, or set LOBBYFORGE_EMAIL_VERIFICATION=off.'
      )
    );
  }
  if (facts.passwordState === 'undecryptable') {
    out.push(
      check(
        'mail_password',
        false,
        AlertLevel.CRITICAL,
        'The stored SMTP password cannot be decrypted — LOBBYFORGE_SESSION_SECRET changed since it was saved. No mail can be sent; enter the password again.'
      )
    );
  }

  if (facts.provider !== 'none') {
    if (facts.lastTestResult && facts.lastTestResult !== 'ok') {
      out.push(check('mail_last_test', false, AlertLevel.WARNING, `The last test email failed (${facts.lastTestResult}). Check the settings and send another test.`, { result: facts.lastTestResult }));
    } else if (!facts.lastTestResult && facts.mode === 'required') {
      out.push(check('mail_last_test', false, AlertLevel.WARNING, 'Email verification is required, but the current mail settings have not passed a test since they were changed. Send a test email.'));
    }
    if (facts.failures.failures > 0) {
      const auth = facts.failures.authFailures > 0 ? ` ${facts.failures.authFailures} of them were refused at sign-in to the SMTP server (check the user name and password).` : '';
      // In `required` mode, mail that keeps failing locks every new account
      // out: critical while nothing has gone out since the last failure.
      const lastFailureAt = facts.failures.last?.at ?? null;
      const brokenSince = lastFailureAt !== null && (facts.failures.lastSuccessAt === null || facts.failures.lastSuccessAt < lastFailureAt);
      const critical = facts.mode === 'required' && brokenSince;
      out.push(
        check(
          'mail_send_failures',
          false,
          critical ? AlertLevel.CRITICAL : AlertLevel.WARNING,
          `Email(s) that could not be sent in the last 24 hours: ${facts.failures.failures}.${auth}${
            critical ? ' Nothing has been sent since the last failure, and verification is required: new accounts cannot verify.' : ''
          }`,
          {
            failures: facts.failures.failures,
            authFailures: facts.failures.authFailures,
            last: facts.failures.last?.result ?? null,
            lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
            lastSuccessAt: facts.failures.lastSuccessAt === null ? null : new Date(facts.failures.lastSuccessAt).toISOString(),
          }
        )
      );
    }
  }

  if (facts.dailyLimit && facts.sentToday >= facts.dailyLimit * 0.8) {
    const full = facts.sentToday >= facts.dailyLimit;
    out.push(
      check(
        'mail_daily_limit',
        false,
        AlertLevel.WARNING,
        full
          ? `The daily email limit (${facts.dailyLimit}) is reached: further sends are refused until midnight UTC.`
          : `${facts.sentToday} of the daily email limit (${facts.dailyLimit}) used today.`,
        { sentToday: facts.sentToday, dailyLimit: facts.dailyLimit }
      )
    );
  }

  if (facts.provider !== 'none' && facts.transportConfigured) {
    if (facts.port === 25) {
      out.push(check('mail_port_25', false, AlertLevel.INFO, 'SMTP port 25 is blocked on most VPS providers. If tests time out, use 587 (or 2525 / 2587 where the provider offers it).'));
    }
    if (facts.dns && (facts.dns.spf === false || facts.dns.dmarc === false)) {
      const missing = [facts.dns.spf === false ? 'an SPF TXT record' : null, facts.dns.dmarc === false ? 'a _dmarc record' : null].filter(Boolean).join(' and ');
      out.push(
        check('mail_dns', false, AlertLevel.INFO, `The sender domain ${facts.dns.domain} has no ${missing}; mail may land in spam. Your provider's setup page lists the records to add.`, {
          domain: facts.dns.domain,
          spf: facts.dns.spf,
          dmarc: facts.dns.dmarc,
        })
      );
    }
    if (facts.provider === 'gmail' && facts.production) {
      out.push(check('mail_gmail', false, AlertLevel.INFO, 'Mail goes out through a personal Gmail account (about 500 a day, from a Gmail address). Fine for testing and small closed groups; use a relay for an open community.'));
    }
  }

  if (!out.some((c) => !c.ok && c.level !== AlertLevel.INFO)) {
    const transport = facts.provider === 'none' ? 'no mail transport' : `mail through ${name}`;
    out.push(check('mail', true, AlertLevel.INFO, `Email: ${transport}; verification ${facts.mode}.`, { provider: facts.provider, mode: facts.mode }));
  }
  return out;
}

const DNS_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Does `name` publish a TXT record starting with `prefix`? null when the lookup itself failed. */
async function hasTxt(name: string, prefix: string): Promise<boolean | null> {
  const { promises: dns } = await import('node:dns');
  try {
    const records = await withTimeout(dns.resolveTxt(name));
    return records.some((chunks) => chunks.join('').trim().toLowerCase().startsWith(prefix));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // "No such record" is an answer; a timeout or SERVFAIL is not.
    return code === 'ENODATA' || code === 'ENOTFOUND' ? false : null;
  }
}

/** Gather the facts and build the checks. Never throws. */
export async function collectMailChecks(): Promise<DoctorCheck[]> {
  try {
    const { resolveMailSettings } = await import('./settings');
    const { mailFailureStats, sentToday } = await import('./stats');
    const { parseFromAddress } = await import('./send');
    const settings = await resolveMailSettings({ fresh: true });
    const [failures, today] = await Promise.all([mailFailureStats(), sentToday()]);
    let dns: MailDoctorFacts['dns'] = null;
    const from = parseFromAddress(settings.from);
    const localHost = !settings.host || settings.host === 'localhost' || settings.host === 'mailpit' || settings.provider === 'mailpit';
    if (from && settings.transportConfigured && !localHost) {
      const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
      const [spf, dmarc] = await Promise.all([hasTxt(domain, 'v=spf1'), hasTxt(`_dmarc.${domain}`, 'v=dmarc1')]);
      dns = { domain, spf, dmarc };
    }
    return buildMailChecks({
      provider: settings.provider,
      mode: settings.verification.mode,
      transportConfigured: settings.transportConfigured,
      passwordState: settings.passwordState,
      port: settings.port,
      // Only a test of exactly the configuration in force counts.
      lastTestResult: settings.lastTest.current ? settings.lastTest.result : null,
      invalidEnv: settings.env.invalid,
      settingsLoaded: settings.loaded,
      failures,
      sentToday: today,
      dailyLimit: settings.dailyLimit,
      production: process.env.NODE_ENV === 'production',
      dns,
    });
  } catch (error) {
    console.error('[doctor] email checks failed', JSON.stringify((error as Error).message));
    return [check('mail_settings', false, AlertLevel.WARNING, 'Email settings could not be checked.')];
  }
}
