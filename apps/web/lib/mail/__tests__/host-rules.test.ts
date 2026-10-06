/**
 * SMTP host rules (docs/EMAIL.md §3.4): allowed ports, link-local and
 * metadata addresses refused everywhere (on the RESOLVED addresses),
 * private ranges refused in production except the compose `mailpit`, and
 * `none` security only for localhost / mailpit.
 */
import { describe, expect, it } from 'vitest';
import { checkSmtpTarget, isLinkLocalOrMetadata, smtpHostSyntaxOk, smtpPortAllowed, staticSmtpTargetRefusal } from '../host-rules';

const PROD = { production: true, official: false };
const DEV = { production: false, official: false };
const HUB = { production: true, official: true };
const resolver = (map: Record<string, string[] | null>) => async (host: string) => map[host] ?? null;

describe('SMTP host rules', () => {
  it('allows the submission ports, and mailpit ports only in development (or the compose host)', () => {
    for (const port of [25, 465, 587, 2465, 2525, 2587]) expect(smtpPortAllowed(port, 'smtp.example.org', PROD)).toBe(true);
    for (const port of [22, 80, 443, 3306, 6379, 8025, 8465]) expect(smtpPortAllowed(port, 'smtp.example.org', DEV)).toBe(false);
    expect(smtpPortAllowed(1025, 'localhost', DEV)).toBe(true);
    expect(smtpPortAllowed(19525, 'localhost', DEV)).toBe(true);
    expect(smtpPortAllowed(1025, 'smtp.example.org', PROD)).toBe(false);
    expect(smtpPortAllowed(1025, 'mailpit', PROD)).toBe(true);
    expect(smtpPortAllowed(19525, 'mailpit', PROD)).toBe(false);
    expect(smtpPortAllowed(1025, 'mailpit', HUB)).toBe(false);
  });

  it('accepts host names and IP literals, nothing else', () => {
    for (const ok of ['smtp.example.org', 'mailpit', 'localhost', '203.0.113.7', '[2001:db8::1]', 'SMTP.Example.ORG.']) expect(smtpHostSyntaxOk(ok)).toBe(true);
    for (const bad of ['', 'smtp://x', 'a b', 'x/y', 'host:587', '-bad.example', 'a..b']) expect(smtpHostSyntaxOk(bad)).toBe(false);
  });

  it('recognises link-local and metadata addresses in every notation', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.169.254', 'not-an-ip']) {
      expect(isLinkLocalOrMetadata(ip), ip).toBe(true);
    }
    for (const ip of ['10.0.0.1', '127.0.0.1', '203.0.113.7', '2001:db8::1', 'fd00:ec2::253']) expect(isLinkLocalOrMetadata(ip), ip).toBe(false);
  });

  it('refuses a name that resolves to a metadata address, even in development', async () => {
    const check = await checkSmtpTarget({ host: 'evil.example', port: 587, security: 'starttls' }, DEV, resolver({ 'evil.example': ['169.254.169.254'] }));
    expect(check).toEqual({ ok: false, detail: 'address_not_allowed' });
    const mixed = await checkSmtpTarget({ host: 'evil.example', port: 587, security: 'starttls' }, DEV, resolver({ 'evil.example': ['203.0.113.7', 'fd00:ec2::254'] }));
    expect(mixed).toEqual({ ok: false, detail: 'address_not_allowed' });
  });

  it('refuses loopback and private addresses in production, except the compose mailpit (not on the hub)', async () => {
    // Public addresses (documentation ranges such as 203.0.113.0/24 count as blocked in production).
    const r = resolver({ 'internal.example': ['10.1.2.3'], localhost: ['127.0.0.1'], mailpit: ['172.18.0.5'], 'smtp.example.org': ['93.184.215.14'] });
    expect(await checkSmtpTarget({ host: 'internal.example', port: 587, security: 'starttls' }, PROD, r)).toEqual({ ok: false, detail: 'address_not_allowed' });
    expect(await checkSmtpTarget({ host: 'localhost', port: 587, security: 'starttls' }, PROD, r)).toEqual({ ok: false, detail: 'address_not_allowed' });
    expect(await checkSmtpTarget({ host: 'mailpit', port: 1025, security: 'none' }, PROD, r)).toEqual({ ok: true, host: 'mailpit', addresses: ['172.18.0.5'] });
    expect(await checkSmtpTarget({ host: 'mailpit', port: 1025, security: 'none' }, HUB, r)).toEqual({ ok: false, detail: 'port_not_allowed' });
    expect(await checkSmtpTarget({ host: 'internal.example', port: 587, security: 'starttls' }, DEV, r)).toMatchObject({ ok: true });
    expect(await checkSmtpTarget({ host: 'smtp.example.org', port: 587, security: 'starttls' }, PROD, r)).toEqual({
      ok: true,
      host: 'smtp.example.org',
      addresses: ['93.184.215.14'],
    });
  });

  it('allows no TLS only for localhost and mailpit', async () => {
    const r = resolver({ localhost: ['127.0.0.1'], 'smtp.example.org': ['203.0.113.7'], mailpit: ['172.18.0.5'] });
    expect(await checkSmtpTarget({ host: 'localhost', port: 19525, security: 'none' }, DEV, r)).toMatchObject({ ok: true });
    expect(await checkSmtpTarget({ host: 'mailpit', port: 1025, security: 'none' }, DEV, r)).toMatchObject({ ok: true });
    expect(await checkSmtpTarget({ host: 'smtp.example.org', port: 587, security: 'none' }, DEV, r)).toEqual({ ok: false, detail: 'security_not_allowed' });
  });

  it('reports a name that does not resolve, puts IPv4 first, and checks the port before DNS', async () => {
    expect(await checkSmtpTarget({ host: 'nope.example', port: 587, security: 'starttls' }, PROD, resolver({}))).toEqual({ ok: false, detail: 'host_not_found' });
    expect(
      await checkSmtpTarget({ host: 'dual.example', port: 465, security: 'tls' }, PROD, resolver({ 'dual.example': ['2606:4700::1111', '93.184.215.14'] }))
    ).toMatchObject({ ok: true, addresses: ['93.184.215.14', '2606:4700::1111'] });
    let looked = false;
    const spy = async () => {
      looked = true;
      return ['203.0.113.7'];
    };
    expect(await checkSmtpTarget({ host: 'smtp.example.org', port: 22, security: 'starttls' }, PROD, spy)).toEqual({ ok: false, detail: 'port_not_allowed' });
    expect(looked).toBe(false);
  });

  it('has a DNS-free variant for the admin save', () => {
    expect(staticSmtpTargetRefusal({ host: 'smtp.example.org', port: 587, security: 'starttls' }, PROD)).toBeNull();
    expect(staticSmtpTargetRefusal({ host: '169.254.169.254', port: 587, security: 'starttls' }, DEV)).toEqual({ ok: false, detail: 'address_not_allowed' });
    expect(staticSmtpTargetRefusal({ host: '10.0.0.5', port: 587, security: 'starttls' }, PROD)).toEqual({ ok: false, detail: 'address_not_allowed' });
    expect(staticSmtpTargetRefusal({ host: 'smtp.example.org', port: 8080, security: 'starttls' }, PROD)).toEqual({ ok: false, detail: 'port_not_allowed' });
    expect(staticSmtpTargetRefusal({ host: 'smtp.example.org', port: 25, security: 'none' }, PROD)).toEqual({ ok: false, detail: 'security_not_allowed' });
    expect(staticSmtpTargetRefusal({ host: 'mailpit', port: 1025, security: 'none' }, PROD)).toBeNull();
  });
});
