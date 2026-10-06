/**
 * The provider registry (docs/EMAIL.md §2.2): every preset is complete —
 * a docs URL, ports §3.4 allows (recommended first), hints that exist in
 * every complete language — and the development preset is offered only
 * where §2.2 says.
 */
import { describe, expect, it } from 'vitest';
import { getDiscovery, readCatalogue } from '@/lib/i18n/catalogue';
import { ALLOWED_SMTP_PORTS, MAIL_PROVIDER_IDS } from '../types';
import { MAILPIT_COMPOSE_PRESET, MAIL_PROVIDERS, getMailProvider, mailProviderMessageKeys, mailpitOffered, offeredMailProviders, presetHost, presetRegionForHost } from '../providers';
import { staticSmtpTargetRefusal } from '../host-rules';

describe('mail provider registry', () => {
  it('has exactly one preset per provider id, in the contract tiers', () => {
    expect(MAIL_PROVIDERS.map((p) => p.id).sort()).toEqual([...MAIL_PROVIDER_IDS].sort());
    const tiers = Object.fromEntries(MAIL_PROVIDERS.map((p) => [p.id, p.tier]));
    expect(tiers).toEqual({
      ses: 'professional',
      scaleway: 'professional',
      brevo: 'free',
      smtp2go: 'free',
      resend: 'free',
      mailjet: 'free',
      mailgun: 'free',
      gmail: 'free',
      custom: 'custom',
      mailpit: 'development',
    });
  });

  it.each(MAIL_PROVIDERS.map((p) => [p.id, p] as const))('%s: docs URL, transport, ports and host', (_id, preset) => {
    expect(preset.transport).toBe('smtp');
    expect(preset.docsUrl).toMatch(/^https:\/\/[^\s]+$/);
    expect(preset.name.trim()).not.toBe('');
    expect(preset.ports.length).toBeGreaterThan(0);
    expect(new Set(preset.ports.map((p) => p.port)).size).toBe(preset.ports.length);
    for (const { port, security } of preset.ports) {
      if (preset.tier === 'development') {
        expect(security).toBe('none');
        expect([1025, 19525]).toContain(port);
      } else {
        expect(ALLOWED_SMTP_PORTS).toContain(port);
        expect(security).not.toBe('none');
        // Implicit TLS lives on 465/2465; every other port starts plain and upgrades.
        expect(security).toBe(port === 465 || port === 2465 ? 'tls' : 'starttls');
      }
    }
    if (preset.tier === 'custom') {
      expect(preset.host).toBeUndefined();
      expect(preset.regions).toBeUndefined();
    } else {
      expect(Boolean(preset.host) !== Boolean(preset.regions?.length)).toBe(true);
    }
  });

  it('keeps the verified hosts, ports and username conventions', () => {
    const ses = getMailProvider('ses')!;
    expect(ses.regions![0]).toEqual({ id: 'eu-central-1', host: 'email-smtp.eu-central-1.amazonaws.com' });
    expect(ses.regions!.map((r) => r.id)).not.toContain('eu-south-1'); // no SMTP endpoint there
    expect(ses.ports.map((p) => p.port)).toEqual([587, 2587, 465, 2465]);
    expect(getMailProvider('scaleway')!.host).toBe('smtp.tem.scaleway.com');
    expect(getMailProvider('brevo')!.host).toBe('smtp-relay.brevo.com');
    expect(getMailProvider('smtp2go')!.ports[0]!.port).toBe(2525);
    expect(getMailProvider('resend')!.host).toBe('smtp.resend.com');
    expect(getMailProvider('mailjet')!.host).toBe('in-v3.mailjet.com');
    expect(getMailProvider('mailgun')!.regions).toEqual([
      { id: 'us', host: 'smtp.mailgun.org' },
      { id: 'eu', host: 'smtp.eu.mailgun.org' },
    ]);
    expect(getMailProvider('gmail')!.host).toBe('smtp.gmail.com');
    expect(getMailProvider('brevo')!.freeTier!.perDay).toBe(300);
    expect(getMailProvider('resend')!.freeTier).toMatchObject({ perDay: 100, perMonth: 3000 });
    expect(getMailProvider('mailjet')!.freeTier).toMatchObject({ perDay: 200, perMonth: 6000 });
    expect(getMailProvider('mailgun')!.freeTier!.perDay).toBe(100);
    expect(getMailProvider('gmail')!.freeTier!.perDay).toBe(500);
  });

  it('has every hint and note in every complete language, never empty', () => {
    const keys = mailProviderMessageKeys();
    expect(keys.length).toBeGreaterThan(20);
    for (const locale of getDiscovery().locales.filter((l) => l.status === 'complete')) {
      const catalogue = readCatalogue(locale.code).files['mailProviders.json'] ?? {};
      for (const key of keys) {
        expect(catalogue[key]?.trim(), `${locale.code}: ${key}`).toBeTruthy();
      }
    }
    // The username hint for Resend is the literal user name.
    expect(readCatalogue('en').files['mailProviders.json']!['mailProviders.resend.usernameHint']).toContain('resend');
  });

  it('derives hosts from regions and back', () => {
    const ses = getMailProvider('ses')!;
    expect(presetHost(ses)).toBe('email-smtp.eu-central-1.amazonaws.com');
    expect(presetHost(ses, 'us-east-1')).toBe('email-smtp.us-east-1.amazonaws.com');
    expect(presetHost(ses, 'nowhere')).toBe('email-smtp.eu-central-1.amazonaws.com');
    expect(presetRegionForHost(ses, 'EMAIL-SMTP.EU-WEST-1.AMAZONAWS.COM')).toBe('eu-west-1');
    expect(presetHost(getMailProvider('custom')!)).toBeNull();
  });

  it('offers mailpit on every instance but the official hub, as the variant this environment can reach', () => {
    expect(mailpitOffered({ official: false })).toBe(true);
    expect(mailpitOffered({ official: true })).toBe(false);
    expect(offeredMailProviders({ production: true, official: true }).map((p) => p.id)).not.toContain('mailpit');
    expect(offeredMailProviders({ production: false, official: true }).map((p) => p.id)).not.toContain('mailpit');
    // A dev host reaches mailpit on localhost:19525 …
    const dev = offeredMailProviders({ production: false, official: false }).find((p) => p.id === 'mailpit')!;
    expect(dev).toMatchObject({ tier: 'development', host: 'localhost' });
    expect(dev.ports[0]).toEqual({ port: 19525, security: 'none' });
    // … a production build (inside compose) on the service, mailpit:1025 — what the host rules accept there.
    const compose = offeredMailProviders({ production: true, official: false }).find((p) => p.id === 'mailpit')!;
    expect(compose).toEqual(MAILPIT_COMPOSE_PRESET);
    expect(compose).toMatchObject({ tier: 'development', host: 'mailpit', ports: [{ port: 1025, security: 'none' }] });
    expect(staticSmtpTargetRefusal({ host: compose.host!, port: 1025, security: 'none' }, { production: true, official: false })).toBeNull();
    expect(getMailProvider('mailpit', { production: true })).toBe(MAILPIT_COMPOSE_PRESET);
    expect(getMailProvider('mailpit', { production: false })!.host).toBe('localhost');
  });
});
