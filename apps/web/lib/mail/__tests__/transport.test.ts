/**
 * The SMTP transport (docs/EMAIL.md §2.1) with nodemailer mocked: the
 * options it is built with (pinned address + TLS server name, certificate
 * checks on, timeouts, no file/URL access), the pooled cache keyed by the
 * settings, and the classification of SMTP failures into result + detail
 * codes (§5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: h.createTransport },
  createTransport: h.createTransport,
}));

import { classifyMailError } from '../classify';
import { closePooledTransport, createSmtpTransport, getPooledTransport, smtpTransportOptions, type SmtpConfig } from '../transport';

const DEV = { production: false, official: false };
const PROD = { production: true, official: false };

function config(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return { provider: 'custom', host: '127.0.0.1', port: 587, security: 'starttls', username: 'user', password: 'pass-word', ...overrides };
}

beforeEach(() => {
  h.sendMail.mockReset().mockResolvedValue({ messageId: '<id@test>' });
  h.verify.mockReset().mockResolvedValue(true);
  h.close.mockReset();
  h.createTransport.mockReset().mockImplementation(() => ({ sendMail: h.sendMail, verify: h.verify, close: h.close }));
  closePooledTransport();
});

describe('SMTP transport options', () => {
  it('connects to the pinned address and verifies the certificate against the host name', () => {
    const options = smtpTransportOptions(config({ host: 'smtp.example.org' }), '203.0.113.9', false);
    expect(options).toMatchObject({
      host: '203.0.113.9',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      servername: 'smtp.example.org',
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.example.org' },
      auth: { user: 'user', pass: 'pass-word' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
    expect(options).not.toHaveProperty('pool');
  });

  it('implicit TLS, no TLS (mailpit), no auth, and the pool', () => {
    expect(smtpTransportOptions(config({ port: 465, security: 'tls' }), '127.0.0.1', false)).toMatchObject({ secure: true, requireTLS: false });
    const plain = smtpTransportOptions(config({ host: 'mailpit', port: 1025, security: 'none', username: null, password: null }), '172.18.0.5', true);
    expect(plain).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true, pool: true, maxConnections: 2 });
    expect(plain).not.toHaveProperty('auth');
    // TLS verification can never be switched off: nothing turns rejectUnauthorized false.
    expect(plain.tls.rejectUnauthorized).toBe(true);
    // An IP literal host has no server name to check against.
    expect(smtpTransportOptions(config(), '127.0.0.1', false)).not.toHaveProperty('servername');
  });
});

describe('createSmtpTransport', () => {
  it('refuses a host the rules do not allow, without building a transport', async () => {
    expect(await createSmtpTransport(config({ host: '169.254.169.254' }), DEV)).toEqual({
      ok: false,
      outcome: { result: 'host_not_allowed', detail: 'address_not_allowed' },
    });
    expect(await createSmtpTransport(config({ port: 8080 }), DEV)).toEqual({ ok: false, outcome: { result: 'host_not_allowed', detail: 'port_not_allowed' } });
    expect(await createSmtpTransport(config(), PROD)).toEqual({ ok: false, outcome: { result: 'host_not_allowed', detail: 'address_not_allowed' } });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it('sends and verifies through nodemailer, classifying failures', async () => {
    const built = await createSmtpTransport(config(), DEV);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(h.createTransport.mock.calls[0]![0]).toMatchObject({ host: '127.0.0.1', disableFileAccess: true, disableUrlAccess: true });
    expect(await built.transport.verify()).toEqual({ ok: true });
    expect(await built.transport.send({ from: 'a@example.org', to: 'b@example.org', subject: 's', text: 't', html: '<p>t</p>' })).toEqual({
      ok: true,
      messageId: '<id@test>',
    });
    expect(h.sendMail.mock.calls[0]![0]).toMatchObject({ to: 'b@example.org', disableFileAccess: true, disableUrlAccess: true });

    h.verify.mockRejectedValue(Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 }));
    expect(await built.transport.verify()).toEqual({ ok: false, result: 'auth', detail: 'check_credentials' });
    h.sendMail.mockRejectedValue(Object.assign(new Error('Recipient rejected'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }));
    expect(await built.transport.send({ from: 'a@example.org', to: 'b@example.org', subject: 's', text: 't', html: 't' })).toEqual({
      ok: false,
      result: 'recipient_rejected',
      permanent: true,
    });
  });

  it('keeps one pooled transport per configuration and rebuilds it when the settings change', async () => {
    const a = await getPooledTransport(config(), DEV);
    const b = await getPooledTransport(config(), DEV);
    expect(a.ok && b.ok && a.transport === b.transport).toBe(true);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0]![0]).toMatchObject({ pool: true });
    const c = await getPooledTransport(config({ password: 'changed' }), DEV);
    expect(c.ok && a.ok && c.transport !== a.transport).toBe(true);
    expect(h.createTransport).toHaveBeenCalledTimes(2);
  });
});

describe('classifyMailError', () => {
  const ctx = (port: number, security: 'tls' | 'starttls' | 'none', providerId = 'custom', providerPorts?: number[]) => ({ port, security, providerId, providerPorts });

  it('a timeout on 25/465/587 suggests the provider’s alternative port', () => {
    const timeout = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    expect(classifyMailError(timeout, ctx(587, 'starttls', 'smtp2go', [2525, 587, 25, 465]))).toMatchObject({ result: 'timeout', detail: 'try_port_2525' });
    expect(classifyMailError(timeout, ctx(465, 'tls', 'ses', [587, 2587, 465, 2465]))).toMatchObject({ result: 'timeout', detail: 'try_port_2587' });
    expect(classifyMailError(timeout, ctx(25, 'starttls'))).toMatchObject({ result: 'timeout', detail: 'try_port_2525' });
    expect(classifyMailError(timeout, ctx(2525, 'starttls'))).toEqual({ result: 'timeout', detail: undefined, permanent: false });
  });

  it('TLS problems: certificate, and the port/mode mismatch both ways', () => {
    expect(classifyMailError(Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET' }), ctx(465, 'tls'))).toMatchObject({ result: 'tls', detail: 'tls_certificate' });
    expect(classifyMailError(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ESOCKET' }), ctx(587, 'starttls'))).toMatchObject({
      result: 'tls',
      detail: 'tls_certificate',
    });
    expect(
      classifyMailError(Object.assign(new Error('140:error:0A00010B:SSL routines::wrong version number'), { code: 'ESOCKET' }), ctx(587, 'tls'))
    ).toMatchObject({ result: 'tls', detail: 'use_starttls' });
    expect(classifyMailError(Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }), ctx(465, 'starttls'))).toMatchObject({ result: 'timeout' });
    expect(classifyMailError(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' }), ctx(465, 'starttls'))).toMatchObject({
      result: 'tls',
      detail: 'use_tls',
    });
  });

  it('auth (Gmail gets the app-password hint), sender and message rejections, DNS and refused connections', () => {
    expect(classifyMailError(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }), ctx(587, 'starttls', 'gmail'))).toMatchObject({
      result: 'auth',
      detail: 'gmail_app_password',
    });
    expect(classifyMailError(Object.assign(new Error('Sender address rejected'), { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553 }), ctx(587, 'starttls'))).toEqual({
      result: 'sender_rejected',
      detail: 'sender_domain',
      permanent: true,
    });
    expect(classifyMailError(Object.assign(new Error('Message rejected'), { code: 'EMESSAGE', responseCode: 554 }), ctx(587, 'starttls'))).toMatchObject({
      result: 'sender_rejected',
      detail: 'message_rejected',
    });
    expect(classifyMailError(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.nope'), { code: 'EDNS' }), ctx(587, 'starttls'))).toMatchObject({
      result: 'connection',
      detail: 'host_not_found',
    });
    expect(classifyMailError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET' }), ctx(587, 'starttls'))).toMatchObject({
      result: 'connection',
      detail: 'connection_refused',
    });
    expect(classifyMailError(new Error('something odd'), ctx(587, 'starttls'))).toEqual({ result: 'connection', permanent: false });
  });
});
