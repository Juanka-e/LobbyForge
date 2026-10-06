/**
 * Turn a nodemailer / socket error into a classified outcome (docs/EMAIL.md
 * §5): a `result` and a `detail` CODE, never the server's free text (which
 * can echo addresses or credentials, and is not translatable).
 *
 * Nodemailer overwrites a socket error's `code` with its own (`ESOCKET`,
 * `ECONNECTION`, …), so the underlying cause is read from the message too.
 */
import type { MailOutcome, MailTestDetail, SmtpSecurity } from './types';

export interface ClassifyContext {
  port: number | null;
  security: SmtpSecurity | null;
  providerId?: string | null;
  /** The ports the provider offers (to suggest an alternative after a timeout). */
  providerPorts?: readonly number[];
}

interface ErrorLike {
  code?: unknown;
  errno?: unknown;
  command?: unknown;
  responseCode?: unknown;
  message?: unknown;
}

const TLS_MESSAGE = /certificate|self[- ]signed|ssl|tls|wrong version number|altnames|unable to verify|handshake/i;
const CERT_MESSAGE = /certificate|self[- ]signed|altnames|unable to verify|cert_/i;

function timeoutDetail(context: ClassifyContext): MailTestDetail | undefined {
  if (context.port === null || ![25, 465, 587].includes(context.port)) return undefined;
  const offered = context.providerPorts ?? [2525, 2587];
  if (offered.includes(2525)) return 'try_port_2525';
  if (offered.includes(2587)) return 'try_port_2587';
  return undefined;
}

export function classifyMailError(error: unknown, context: ClassifyContext): MailOutcome & { permanent: boolean } {
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(error ?? '');
  const command = typeof e.command === 'string' ? e.command.toUpperCase() : '';
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const permanent = responseCode !== null && responseCode >= 500;

  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530 || command.startsWith('AUTH')) {
    return { result: 'auth', detail: context.providerId === 'gmail' ? 'gmail_app_password' : 'check_credentials', permanent: true };
  }
  if (command.startsWith('MAIL FROM')) return { result: 'sender_rejected', detail: 'sender_domain', permanent };
  if (command.startsWith('RCPT TO') || (code === 'EENVELOPE' && /recipient/i.test(message))) {
    return { result: 'recipient_rejected', permanent };
  }
  if (code === 'EENVELOPE') return { result: 'sender_rejected', detail: 'sender_domain', permanent };
  if (code === 'EMESSAGE' || command === 'DATA' || command.startsWith('DATA')) {
    return { result: 'sender_rejected', detail: 'message_rejected', permanent };
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return { result: 'timeout', detail: timeoutDetail(context), permanent: false };
  }
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return { result: 'connection', detail: 'host_not_found', permanent: false };
  }
  if (/ECONNREFUSED/i.test(message) || e.code === 'ECONNREFUSED') {
    return { result: 'connection', detail: 'connection_refused', permanent: false };
  }
  if (code === 'ETLS' || code === 'EREQUIRETLS' || TLS_MESSAGE.test(message)) {
    let detail: MailTestDetail | undefined;
    if (CERT_MESSAGE.test(message)) detail = 'tls_certificate';
    else if (context.security === 'tls' && (/wrong version number|packet length too long|unknown protocol/i.test(message) || context.port === 587 || context.port === 2587 || context.port === 25 || context.port === 2525)) {
      detail = 'use_starttls';
    } else if (context.security === 'starttls' && (context.port === 465 || context.port === 2465)) detail = 'use_tls';
    else if (context.security === 'starttls' && /STARTTLS/i.test(message)) detail = 'use_tls';
    return { result: 'tls', ...(detail ? { detail } : {}), permanent: false };
  }
  // A starttls client talking to an implicit-TLS port sees the connection
  // close before any greeting: that is a port/mode mismatch, not a network fault.
  if (context.security === 'starttls' && (context.port === 465 || context.port === 2465) && /closed|greeting/i.test(message)) {
    return { result: 'tls', detail: 'use_tls', permanent: false };
  }
  return { result: 'connection', permanent: false };
}
