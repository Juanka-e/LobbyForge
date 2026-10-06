/**
 * The mail transport (docs/EMAIL.md §2.1). One interface, one
 * implementation in v1: SMTP through nodemailer (exact pin in
 * apps/web/package.json). An HTTP API transport later is a new `kind`.
 *
 *   - the host passes the §3.4 rules first and is resolved ONCE; the
 *     connection goes to an allowed address with the host name as the TLS
 *     server name, so certificate checks still apply to the name and a DNS
 *     answer that changes afterwards cannot redirect it;
 *   - certificate verification is always on (TLS 1.2+); `none` security
 *     (mailpit, localhost) sends without TLS at all;
 *   - timeouts: connection 10 s, greeting 10 s, socket 20 s;
 *   - `disableFileAccess` / `disableUrlAccess`: message content can never
 *     make nodemailer read a file or fetch a URL;
 *   - one POOLED transport per configuration for sends, cached on
 *     `globalThis` and keyed by a hash of the settings (password included,
 *     hashed): a settings change builds a new one. It is also rebuilt every
 *     10 minutes so the host is resolved (and checked) again. The test
 *     button uses a fresh, unpooled transport.
 *
 * Server-only.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { classifyMailError } from './classify';
import { checkSmtpTarget, type SmtpTargetContext } from './host-rules';
import { getMailProvider } from './providers';
import type { MailOutcome, MailProviderSetting, SmtpSecurity } from './types';

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export type SendResult = { ok: true; messageId: string | null } | ({ ok: false; permanent: boolean } & MailOutcome);
export type VerifyResult = { ok: true } | ({ ok: false } & MailOutcome);

export interface MailTransport {
  readonly kind: 'smtp'; // later: 'ses-api', 'resend-api', ...
  send(message: OutgoingMail): Promise<SendResult>;
  /** Connect and authenticate, no message (the test button). */
  verify(): Promise<VerifyResult>;
  close(): void;
}

export interface SmtpConfig {
  provider: MailProviderSetting;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  /** `ResolvedMailSettings.authStamp` — what the cache key uses instead of the password. */
  authStamp?: string | null;
}

export const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
const POOL_TTL_MS = 10 * 60_000;
const RETIRE_DELAY_MS = 30_000;
const CACHE_KEY = '__lobbyforgeMailTransport__';

type Transporter = ReturnType<typeof nodemailer.createTransport>;

function classifyContext(config: SmtpConfig) {
  return {
    port: config.port,
    security: config.security,
    providerId: config.provider,
    providerPorts: getMailProvider(config.provider)?.ports.map((p) => p.port),
  };
}

/** The nodemailer options for one resolved address. Exported for tests. */
export function smtpTransportOptions(config: SmtpConfig, address: string, pooled: boolean) {
  const servername = isIP(config.host) ? undefined : config.host;
  return {
    host: address,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(servername ? { servername } : {}),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, ...(servername ? { servername } : {}) },
    ...(config.username ? { auth: { user: config.username, pass: config.password ?? '' } } : {}),
    ...SMTP_TIMEOUTS,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    ...(pooled ? { pool: true as const, maxConnections: 2, maxMessages: 50 } : {}),
  };
}

class SmtpMailTransport implements MailTransport {
  readonly kind = 'smtp' as const;
  constructor(
    private readonly transporter: Transporter,
    private readonly config: SmtpConfig
  ) {}

  async send(message: OutgoingMail): Promise<SendResult> {
    try {
      const info = (await this.transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      })) as { messageId?: string };
      return { ok: true, messageId: info?.messageId ?? null };
    } catch (error) {
      return { ok: false, ...classifyMailError(error, classifyContext(this.config)) };
    }
  }

  async verify(): Promise<VerifyResult> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (error) {
      const { permanent: _permanent, ...outcome } = classifyMailError(error, classifyContext(this.config));
      return { ok: false, ...outcome };
    }
  }

  close(): void {
    try {
      this.transporter.close();
    } catch {
      /* already closed */
    }
  }
}

export type CreateTransportResult = { ok: true; transport: MailTransport; address: string } | { ok: false; outcome: MailOutcome };

/** Check the host (§3.4), resolve it once and build a transport bound to an allowed address. */
export async function createSmtpTransport(
  config: SmtpConfig,
  context: SmtpTargetContext,
  options: { pooled?: boolean } = {}
): Promise<CreateTransportResult> {
  const target = await checkSmtpTarget({ host: config.host, port: config.port, security: config.security }, context);
  if (!target.ok) {
    return {
      ok: false,
      outcome: target.detail === 'host_not_found' ? { result: 'connection', detail: 'host_not_found' } : { result: 'host_not_allowed', detail: target.detail },
    };
  }
  const address = target.addresses[0]!;
  const transporter = nodemailer.createTransport(smtpTransportOptions({ ...config, host: target.host }, address, Boolean(options.pooled)));
  return { ok: true, transport: new SmtpMailTransport(transporter, { ...config, host: target.host }), address };
}

interface PoolEntry {
  key: string;
  createdAt: number;
  transport: MailTransport;
}

interface PoolHolder {
  entry?: PoolEntry;
  pending?: { key: string; promise: Promise<CreateTransportResult> };
}

function poolHolder(): PoolHolder {
  const g = globalThis as unknown as Record<string, PoolHolder | undefined>;
  let value = g[CACHE_KEY];
  if (!value) {
    value = {};
    g[CACHE_KEY] = value;
  }
  return value;
}

/**
 * A hash of everything that shapes the connection. The password is
 * represented by its non-secret `authStamp` (which changes whenever the
 * password does), so no password is ever hashed here.
 */
export function transportKey(config: SmtpConfig, context: SmtpTargetContext): string {
  const auth = config.authStamp ?? (config.username === null ? null : 'unstamped');
  return createHash('sha256')
    .update(JSON.stringify([config.provider, config.host, config.port, config.security, config.username, auth, context.production, context.official]))
    .digest('hex');
}

function retire(transport: MailTransport): void {
  // Let messages already handed to the pool finish before closing it.
  const timer = setTimeout(() => transport.close(), RETIRE_DELAY_MS);
  timer.unref?.();
}

/** The pooled transport for this configuration (built, or rebuilt after a change or every 10 minutes). */
export async function getPooledTransport(config: SmtpConfig, context: SmtpTargetContext): Promise<CreateTransportResult> {
  const holder = poolHolder();
  const key = transportKey(config, context);
  const now = Date.now();
  if (holder.entry && holder.entry.key === key && now - holder.entry.createdAt < POOL_TTL_MS) {
    return { ok: true, transport: holder.entry.transport, address: '' };
  }
  if (holder.pending?.key === key) return holder.pending.promise;
  const promise = createSmtpTransport(config, context, { pooled: true }).then((result) => {
    if (result.ok) {
      const previous = holder.entry;
      holder.entry = { key, createdAt: Date.now(), transport: result.transport };
      if (previous) retire(previous.transport);
    }
    return result;
  });
  holder.pending = { key, promise };
  try {
    return await promise;
  } finally {
    if (holder.pending?.promise === promise) holder.pending = undefined;
  }
}

/** Drop the pooled transport (after a settings save). */
export function closePooledTransport(): void {
  const holder = poolHolder();
  if (holder.entry) retire(holder.entry.transport);
  holder.entry = undefined;
  holder.pending = undefined;
}
