/**
 * Email templates (docs/EMAIL.md §2.3) and the disposable-domain list
 * (§4.5).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIL_TEMPLATES } from '../types';
import { escapeHtml, maskEmail, mailLocale, preferredMailLocale, renderMail, requestLocale } from '../templates';
import { DISPOSABLE_LIST_INFO, emailDomain, isDisposableEmail, normaliseDomainEntry } from '../disposable';

afterEach(() => vi.unstubAllEnvs());

describe('email templates', () => {
  const vars = { instanceName: 'Kaplan <Guild>', code: '042917', link: 'https://chat.example.org/verify-email?t=abc', email: 'n***@example.org' };

  it.each(MAIL_TEMPLATES.flatMap((template) => [[template, 'en'] as const, [template, 'tr'] as const]))('%s in %s: subject, text and HTML', (template, locale) => {
    const mail = renderMail(template, locale, vars);
    expect(mail.subject.trim()).not.toBe('');
    expect(mail.subject).not.toContain('email.');
    expect(mail.text).not.toMatch(/email\.(verify|reset|common|change|test)\./);
    // The code never goes in the subject (lock-screen previews).
    expect(mail.subject).not.toContain(vars.code);
    // No remote images, no tracking, no scripts.
    expect(mail.html).not.toMatch(/<img|<script|<link|url\(/i);
    expect(mail.html).toContain(`lang="${locale}"`);
    // Escaped: the instance name is data.
    expect(mail.html).not.toContain('<Guild>');
    if (template === 'verify' || template === 'reset' || template === 'change-confirm') {
      expect(mail.text).toContain(vars.code);
      expect(mail.text).toContain(vars.link);
      expect(mail.html).toContain(`href="${escapeHtml(vars.link)}"`);
    } else {
      expect(mail.text).not.toContain(vars.code);
      expect(mail.html).not.toContain('href=');
    }
  });

  it('writes in the recipient’s language and states the validity', () => {
    expect(renderMail('verify', 'en', vars).text).toContain('15 minutes');
    expect(renderMail('verify', 'en', vars).text).toContain('24 hours');
    expect(renderMail('reset', 'en', { ...vars, linkHours: 1 }).text).toContain('valid for 1 hour.');
    expect(renderMail('verify', 'tr', vars).subject).toBe('E-posta adresini doğrula');
    expect(renderMail('change-notice', 'tr', vars).text).toContain('n***@example.org');
  });

  it('carries the code alone when no app origin is configured', () => {
    const mail = renderMail('verify', 'en', { ...vars, link: null });
    expect(mail.text).toContain(vars.code);
    expect(mail.html).not.toContain('href=');
  });

  it('picks the language: users.locale when chosen, else the request, else the instance default', () => {
    expect(mailLocale('TR')).toBe('tr');
    expect(mailLocale('xx')).toBe('en');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    expect(mailLocale(null)).toBe('tr');
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
    const req = (headers: Record<string, string>) => new Request('https://x.example/', { headers });
    expect(requestLocale(req({ cookie: 'lf_locale=tr' }))).toBe('tr');
    expect(requestLocale(req({ 'accept-language': 'de;q=0.9, tr-TR;q=0.8' }))).toBe('tr');
    expect(requestLocale(req({}))).toBe('en');
    expect(preferredMailLocale(req({ cookie: 'lf_locale=tr' }), 'en')).toBe('tr');
    expect(preferredMailLocale(req({ cookie: 'lf_locale=en' }), 'tr')).toBe('tr');
  });

  it('masks addresses', () => {
    expect(maskEmail('john@example.org')).toBe('j***@example.org');
    expect(maskEmail('bad')).toBe('***');
  });
});

describe('disposable domains', () => {
  it('is the vendored CC0 list with its provenance header', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'lib', 'mail', 'disposable-domains.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.license).toBe('CC0-1.0');
    expect(String(raw.source)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/disposable-email-domains\/disposable-email-domains\/[0-9a-f]{40}\/disposable_email_blocklist\.conf$/);
    expect(raw.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DISPOSABLE_LIST_INFO.count).toBeGreaterThan(1000);
    expect((raw.domains as string[]).length).toBe(raw.count);
  });

  it('matches listed domains and their subdomains, nothing more', () => {
    expect(isDisposableEmail('someone@mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@inbox.mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@MAILINATOR.COM')).toBe(true);
    expect(isDisposableEmail('someone@gmail.com')).toBe(false);
    // Label boundaries: a suffix that is not a parent domain does not match.
    expect(isDisposableEmail('someone@xyzmailinator.com')).toBe(false);
    expect(isDisposableEmail('not-an-address')).toBe(false);
  });

  it('applies the admin lists on top, allow winning over block', () => {
    expect(isDisposableEmail('a@corp.example', { allow: [], block: ['corp.example'] })).toBe(true);
    expect(isDisposableEmail('a@eu.corp.example', { allow: [], block: ['corp.example'] })).toBe(true);
    expect(isDisposableEmail('a@mailinator.com', { allow: ['mailinator.com'], block: [] })).toBe(false);
    expect(isDisposableEmail('a@x.corp.example', { allow: ['corp.example'], block: ['x.corp.example'] })).toBe(false);
  });

  it('normalises admin entries', () => {
    expect(emailDomain('a@B.Example.')).toBe('b.example');
    expect(normaliseDomainEntry(' @Example.ORG. ')).toBe('example.org');
    expect(normaliseDomainEntry('not a domain')).toBeNull();
    expect(normaliseDomainEntry('localhost')).toBeNull();
  });
});
