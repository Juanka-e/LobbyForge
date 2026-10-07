import type { Translator } from '@/lib/i18n/core';
import type { BotJson } from '@/lib/bots/admin';
import { MASS_MENTION_ISSUE } from '@/lib/bots/settings';
import { RESTRICTED_ACTION_KEYS } from '@/components/email-verification/email-status';
import { handleEmailUnverified } from '@/components/email-verification/email-status-store';

/**
 * Calls to `/api/servers/{id}/bots/**` from the settings page, with every
 * failure turned into a sentence in the admin's language (the API answers
 * with a machine `code`; its English `error` is never shown as-is).
 */

export interface ApiFailure {
  ok: false;
  message: string;
  /** Refused for an unverified email (EMAIL.md §4.2): show the verify notice. */
  emailUnverified?: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

interface ErrorBody {
  error?: string;
  code?: string;
  permissions?: string[];
  limit?: number;
  /** `invalid_request`: "<path>: <reason>" per refused field (English). */
  issues?: unknown;
}

/**
 * A specific reason for an `invalid_request`, from its `issues`, when it is
 * one the page can name: a template that pings @everyone/@here, or
 * allow-list entries that are not domains. Null otherwise (the generic
 * "Some of these values are not valid" stays the fallback).
 */
export function describeInvalidRequest(t: Translator, issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const texts = issues.filter((issue): issue is string => typeof issue === 'string');
  if (texts.some((issue) => issue === MASS_MENTION_ISSUE || issue.endsWith(`: ${MASS_MENTION_ISSUE}`))) {
    return t('bots.error.massMention');
  }
  const domains = texts
    .map((issue) => /(?:^|: )Not a domain: (.+)$/.exec(issue)?.[1])
    .filter((domain): domain is string => Boolean(domain));
  if (domains.length > 0) return t('bots.moderation.invalidDomains', { domains: domains.join(', ') });
  return null;
}

const PERMISSION_KEYS: Record<string, string> = {
  read_messages: 'bots.permission.read_messages',
  send_messages: 'bots.permission.send_messages',
  join_voice: 'bots.permission.join_voice',
  publish_audio: 'bots.permission.publish_audio',
  read_presence: 'bots.permission.read_presence',
  moderate_messages: 'bots.permission.moderate_messages',
  manage_game_session: 'bots.permission.manage_game_session',
  manage_music_queue: 'bots.permission.manage_music_queue',
  read_audit_log: 'bots.permission.read_audit_log',
  slash_commands: 'bots.permission.slash_commands',
  read_members: 'bots.permission.read_members',
  receive_events: 'bots.permission.receive_events',
};

/** What a Bot API v2 permission lets the bot do, in one line (BOT_API_V2 §1.2). */
const PERMISSION_HINT_KEYS: Record<string, string> = {
  slash_commands: 'bots.permissionHint.slash_commands',
  read_members: 'bots.permissionHint.read_members',
  receive_events: 'bots.permissionHint.receive_events',
};

export function permissionLabel(t: Translator, permission: string): string {
  const key = PERMISSION_KEYS[permission];
  return key ? t(key) : permission;
}

export function permissionHint(t: Translator, permission: string): string | null {
  const key = PERMISSION_HINT_KEYS[permission];
  return key ? t(key) : null;
}

export function describeFailure(t: Translator, status: number, body: ErrorBody): string {
  switch (body.code) {
    case 'ungrantable_permissions':
      return t('bots.error.ungrantable', {
        permissions: (body.permissions ?? []).map((p) => permissionLabel(t, p)).join(', '),
      });
    case 'limit_reached':
      return t('bots.error.limit', { count: body.limit ?? 0 });
    case 'invalid_channel':
      return t('bots.error.invalidChannel');
    case 'builtin_permissions_fixed':
      return t('bots.error.builtinFixed');
    case 'invalid_request':
      return describeInvalidRequest(t, body.issues) ?? t('bots.error.invalid');
    default:
      break;
  }
  if (status === 401) return t('bots.error.signIn');
  if (status === 403) return t('bots.error.forbidden');
  if (status === 404) return t('bots.error.notFound');
  if (status === 429) return t('bots.error.rateLimited');
  return t('bots.error.generic', { status });
}

export async function botApi<T>(
  t: Translator,
  url: string,
  init: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown }
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, message: t('bots.error.network') };
  }
  const body = (await response.json().catch(() => ({}))) as T & ErrorBody;
  if (!response.ok && handleEmailUnverified(response.status, body)) {
    return { ok: false, message: t(RESTRICTED_ACTION_KEYS.createBot), emailUnverified: true };
  }
  if (!response.ok) return { ok: false, message: describeFailure(t, response.status, body) };
  return { ok: true, data: body };
}

export interface BotResponse {
  bot: BotJson;
  token?: string;
  created?: boolean;
}
