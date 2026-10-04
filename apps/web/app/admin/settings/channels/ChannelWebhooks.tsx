'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { MAX_WEBHOOKS_PER_CHANNEL, WEBHOOK_NAME_MAX_LENGTH } from '@/lib/bots/catalog';
import {
  createChannelWebhook,
  deleteChannelWebhook,
  listChannelWebhooks,
  patchChannelWebhook,
  rotateChannelWebhook,
  type ChannelWebhook,
  type RequestFailure,
  type WebhookSecret,
} from '@/lib/bots/client-api';
import {
  Dialog,
  Switch,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../bots/ui';

/**
 * Incoming webhooks of one text channel (BOT_API_V2 §5.1): an outside
 * service posts into the channel through a secret URL. The URL holds a
 * token that is stored hashed, so it is shown exactly once — after create
 * and after rotate — with a copy button; closing the dialog is the last
 * time anyone sees it. Every change needs MANAGE_CHANNELS (server-side).
 */

type Notice = { tone: 'success' | 'danger'; text: string } | null;
type Confirm = { kind: 'rotate' | 'delete'; webhook: ChannelWebhook } | null;

function failureText(t: Translator, failure: RequestFailure): string {
  switch (failure.code) {
    case 'network':
      return t('webhooks.error.network');
    case 'webhook_limit_reached':
      return t('webhooks.error.limit', { count: MAX_WEBHOOKS_PER_CHANNEL });
    case 'invalid_request':
      return t('webhooks.error.invalidName', { max: WEBHOOK_NAME_MAX_LENGTH });
    case 'invalid_channel':
      return t('webhooks.error.invalidChannel');
    default:
      break;
  }
  if (failure.status === 401) return t('webhooks.error.signIn');
  if (failure.status === 403) return t('webhooks.error.forbidden');
  if (failure.status === 404) return t('webhooks.error.notFound');
  if (failure.status === 429) return t('webhooks.error.rateLimited');
  return t('webhooks.error.generic', { status: failure.status });
}

function formatDate(t: Translator, iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(t.locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ChannelWebhooks({
  serverId,
  channel,
}: {
  serverId: string;
  channel: { id: string; name: string };
}) {
  const t = useT();
  const titleId = useId();
  const nameId = useId();
  const [webhooks, setWebhooks] = useState<ChannelWebhook[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reveal, setReveal] = useState<WebhookSecret | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    void listChannelWebhooks(serverId, channel.id).then((result) => {
      if (result.ok) setWebhooks(result.data);
      else setLoadError(failureText(t, result));
    });
  }, [serverId, channel.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const atLimit = (webhooks?.length ?? 0) >= MAX_WEBHOOKS_PER_CHANNEL;

  function upsert(webhook: ChannelWebhook) {
    setWebhooks((current) =>
      current?.some((w) => w.id === webhook.id)
        ? current.map((w) => (w.id === webhook.id ? webhook : w))
        : [...(current ?? []), webhook]
    );
  }

  async function create() {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await createChannelWebhook(serverId, channel.id, trimmed);
    setBusy(false);
    if (!result.ok) return setNotice({ tone: 'danger', text: failureText(t, result) });
    upsert(result.data.webhook);
    setName('');
    setReveal(result.data);
  }

  async function toggle(webhook: ChannelWebhook, enabled: boolean) {
    setBusy(true);
    setNotice(null);
    const result = await patchChannelWebhook(serverId, channel.id, webhook.id, { enabled });
    setBusy(false);
    if (!result.ok) return setNotice({ tone: 'danger', text: failureText(t, result) });
    upsert(result.data);
    setNotice({
      tone: 'success',
      text: enabled ? t('webhooks.enabledNotice', { name: webhook.name }) : t('webhooks.disabledNotice', { name: webhook.name }),
    });
  }

  async function runConfirmed() {
    if (!confirm) return;
    const { kind, webhook } = confirm;
    setBusy(true);
    setNotice(null);
    if (kind === 'delete') {
      const result = await deleteChannelWebhook(serverId, channel.id, webhook.id);
      setBusy(false);
      setConfirm(null);
      if (!result.ok) return setNotice({ tone: 'danger', text: failureText(t, result) });
      setWebhooks((current) => current?.filter((w) => w.id !== webhook.id) ?? null);
      return setNotice({ tone: 'success', text: t('webhooks.deleted', { name: webhook.name }) });
    }
    const result = await rotateChannelWebhook(serverId, channel.id, webhook.id);
    setBusy(false);
    setConfirm(null);
    if (!result.ok) return setNotice({ tone: 'danger', text: failureText(t, result) });
    upsert(result.data.webhook);
    setReveal(result.data);
  }

  return (
    <section aria-labelledby={titleId} data-testid="channel-webhooks" className="mt-3 rounded-lg border border-border-subtle bg-surface-container/40 p-3">
      <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
        <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>webhook</span>
        {t('webhooks.title')}
      </h3>
      <p className="mt-1 text-xs text-text-muted">{t('webhooks.intro', { channel: channel.name })}</p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={nameId} className="mb-1 block text-xs font-medium text-text-secondary">
            {t('webhooks.nameLabel')}
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={WEBHOOK_NAME_MAX_LENGTH}
            disabled={busy || atLimit || webhooks === null}
            placeholder={t('webhooks.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void create();
              }
            }}
            className={inputClass}
          />
        </div>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || atLimit || webhooks === null || !name.trim()}
          className={primaryButtonClass}
        >
          {t('webhooks.create')}
        </button>
      </div>
      {atLimit ? <p className="mt-1 text-xs text-text-muted">{t('webhooks.error.limit', { count: MAX_WEBHOOKS_PER_CHANNEL })}</p> : null}

      {notice ? (
        <p role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mt-2 text-xs ${notice.tone === 'danger' ? 'text-danger' : 'text-success'}`}>
          {notice.text}
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-danger">{loadError}</p>
          <button type="button" onClick={load} className={secondaryButtonClass}>
            {t('webhooks.retry')}
          </button>
        </div>
      ) : null}
      {webhooks === null && !loadError ? <p className="mt-3 text-sm text-text-muted">{t('common.loading')}</p> : null}
      {webhooks && webhooks.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border-subtle p-4 text-center text-sm text-text-muted">
          {t('webhooks.empty')}
        </p>
      ) : null}

      {webhooks && webhooks.length > 0 ? (
        <ul className="mt-3 grid gap-2" aria-label={t('webhooks.listLabel', { channel: channel.name })}>
          {webhooks.map((webhook) => (
            <li key={webhook.id} data-testid="channel-webhook" className="rounded-lg border border-border-subtle bg-surface p-3">
              <div className="flex flex-wrap items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-[20px] text-text-muted" aria-hidden>webhook</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium text-text-primary">{webhook.name}</span>
                    <span className={`text-xs font-medium ${webhook.enabled ? 'text-success' : 'text-text-muted'}`}>
                      {webhook.enabled ? t('webhooks.status.enabled') : t('webhooks.status.disabled')}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {webhook.createdAt ? t('webhooks.createdAt', { date: formatDate(t, webhook.createdAt) ?? '' }) : null}
                    {webhook.createdBy?.name ? ` · ${t('webhooks.createdBy', { name: webhook.createdBy.name })}` : null}
                    {' · '}
                    {webhook.lastUsedAt
                      ? t('webhooks.lastUsed', { date: formatDate(t, webhook.lastUsedAt) ?? '' })
                      : t('webhooks.neverUsed')}
                  </p>
                </div>
                <Switch
                  checked={webhook.enabled}
                  disabled={busy}
                  label={t('webhooks.toggle', { name: webhook.name })}
                  onChange={(value) => void toggle(webhook, value)}
                />
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'rotate', webhook })}
                  className={secondaryButtonClass}
                >
                  {t('webhooks.rotate')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'delete', webhook })}
                  className={dangerButtonClass}
                >
                  {t('webhooks.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {confirm ? (
        <Dialog
          title={
            confirm.kind === 'delete'
              ? t('webhooks.confirm.deleteTitle', { name: confirm.webhook.name })
              : t('webhooks.confirm.rotateTitle', { name: confirm.webhook.name })
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={secondaryButtonClass}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-autofocus
                onClick={() => void runConfirmed()}
                disabled={busy}
                className={confirm.kind === 'delete' ? dangerButtonClass : primaryButtonClass}
              >
                {confirm.kind === 'delete' ? t('webhooks.confirm.deleteAction') : t('webhooks.confirm.rotateAction')}
              </button>
            </>
          }
        >
          {confirm.kind === 'delete'
            ? t('webhooks.confirm.deleteBody', { name: confirm.webhook.name })
            : t('webhooks.confirm.rotateBody', { name: confirm.webhook.name })}
        </Dialog>
      ) : null}

      {reveal ? <WebhookUrlDialog secret={reveal} onClose={() => setReveal(null)} /> : null}
    </section>
  );
}

/** The URL, once. Closing the dialog is the last time anyone sees it. */
function WebhookUrlDialog({ secret, onClose }: { secret: WebhookSecret; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const fieldId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      title={t('webhooks.reveal.title', { name: secret.webhook.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={() => void copy()} className={secondaryButtonClass}>
            {copied ? t('webhooks.reveal.copied') : t('webhooks.reveal.copy')}
          </button>
          <button type="button" onClick={onClose} className={primaryButtonClass}>
            {t('webhooks.reveal.done')}
          </button>
        </>
      }
    >
      <p>{t('webhooks.reveal.body')}</p>
      <label htmlFor={fieldId} className="mb-1.5 mt-3 block text-xs font-medium text-text-secondary">
        {t('webhooks.reveal.label')}
      </label>
      <input
        id={fieldId}
        readOnly
        data-autofocus
        data-testid="webhook-url"
        value={secret.url}
        onFocus={(event) => event.currentTarget.select()}
        className={`${inputClass} font-mono text-xs`}
      />
      <p className="mt-3 text-xs text-danger">{t('webhooks.reveal.warning')}</p>
      <p role="status" className="sr-only">
        {copied ? t('webhooks.reveal.copied') : ''}
      </p>
    </Dialog>
  );
}
