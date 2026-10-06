'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import type { BotJson } from '@/lib/bots/admin';
import {
  BOT_API_PERMISSIONS,
  BOT_NAME_MAX_LENGTH,
  BOT_PERMISSIONS,
  MAX_CUSTOM_BOTS_PER_SERVER,
  type BotPermissionId,
} from '@/lib/bots/catalog';
import { BotAvatar, BotBadge, TrustBadge } from '@/app/lobby/BotIdentity';
import { botApi, permissionHint, permissionLabel, type BotResponse } from './api-client';
import { BotIntegrations } from './BotIntegrations';
import EmailUnverifiedNotice, { useEmailRestriction } from '@/components/email-verification/EmailUnverifiedNotice';
import {
  Alert,
  Card,
  Dialog,
  Field,
  Switch,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui';

type ConfirmKind = 'delete' | 'revoke' | 'rotate';
type Confirm = { kind: ConfirmKind; bot: BotJson } | null;

/** Message keys per confirmation, resolved with `t()` where they render. */
const CONFIRM_KEYS: Record<ConfirmKind, { title: string; body: string; action: string }> = {
  delete: { title: 'bots.confirm.deleteTitle', body: 'bots.confirm.deleteBody', action: 'bots.confirm.deleteAction' },
  revoke: { title: 'bots.confirm.revokeTitle', body: 'bots.confirm.revokeBody', action: 'bots.confirm.revokeAction' },
  rotate: { title: 'bots.confirm.rotateTitle', body: 'bots.confirm.rotateBody', action: 'bots.confirm.rotateAction' },
};
type Notice = { tone: 'success' | 'danger'; text: string } | null;

function formatDate(t: Translator, iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(t.locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function PermissionPicker({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: BotPermissionId[];
  onChange: (next: BotPermissionId[]) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const t = useT();
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-1.5 text-xs font-medium text-text-secondary">{t('bots.field.permissions')}</legend>
      {BOT_PERMISSIONS.map((permission) => {
        const id = `${idPrefix}-${permission}`;
        const checked = value.includes(permission);
        const hint = permissionHint(t, permission);
        return (
          <label key={permission} htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm text-text-primary">
            <input
              id={id}
              type="checkbox"
              checked={checked}
              disabled={disabled}
              aria-describedby={hint ? `${id}-hint` : undefined}
              onChange={(event) =>
                onChange(event.target.checked ? [...value, permission] : value.filter((p) => p !== permission))
              }
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              {permissionLabel(t, permission)}
              {!BOT_API_PERMISSIONS.includes(permission) ? (
                <span className="ml-1 text-xs text-text-muted">{t('bots.custom.reserved')}</span>
              ) : null}
              {hint ? (
                <span id={`${id}-hint`} className="block text-xs text-text-muted">
                  {hint}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function CustomBots({
  bots,
  serverId,
  canMutate,
  onChange,
  onRemoved,
  onToken,
  channels = [],
}: {
  bots: BotJson[];
  serverId: string | null;
  canMutate: boolean;
  onChange: (bot: BotJson) => void;
  onRemoved: (botId: string) => void;
  onToken: (reveal: { botName: string; token: string }) => void;
  /** Ungated text channels — the channel-access fallback list. */
  channels?: Array<{ id: string; name: string }>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<BotPermissionId[]>(['read_messages', 'send_messages']);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; permissions: BotPermissionId[] } | null>(null);

  // EMAIL.md §4.2: creating bots and tokens needs a verified email.
  const emailLock = useEmailRestriction();
  const [emailRefused, setEmailRefused] = useState(false);
  const createLocked = emailLock.restricted || emailRefused;
  const disabled = !canMutate || !serverId || busy;
  const atLimit = bots.length >= MAX_CUSTOM_BOTS_PER_SERVER;

  async function create() {
    if (!serverId || !name.trim()) return;
    setBusy(true);
    setNotice(null);
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots`, {
      method: 'POST',
      body: { name: name.trim(), permissions },
    });
    setBusy(false);
    if (!result.ok && result.emailUnverified) {
      setEmailRefused(true);
      return;
    }
    if (!result.ok) {
      setNotice({ tone: 'danger', text: result.message });
      return;
    }
    onChange(result.data.bot);
    setName('');
    if (result.data.token) onToken({ botName: result.data.bot.name, token: result.data.token });
  }

  async function patch(bot: BotJson, body: Record<string, unknown>, done?: string) {
    if (!serverId) return false;
    setBusy(true);
    setNotice(null);
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots/${bot.id}`, { method: 'PATCH', body });
    setBusy(false);
    if (!result.ok) {
      setNotice({ tone: 'danger', text: result.message });
      return false;
    }
    onChange(result.data.bot);
    if (done) setNotice({ tone: 'success', text: done });
    return true;
  }

  /** A bot without a token gets one straight away — there is nothing to break. */
  async function issueToken(bot: BotJson) {
    if (!serverId) return;
    setBusy(true);
    setNotice(null);
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots/${bot.id}/token`, { method: 'POST' });
    setBusy(false);
    if (!result.ok) return setNotice({ tone: 'danger', text: result.message });
    onChange(result.data.bot);
    if (result.data.token) onToken({ botName: bot.name, token: result.data.token });
  }

  async function runConfirmed() {
    if (!confirm || !serverId) return;
    const { kind, bot } = confirm;
    setBusy(true);
    setNotice(null);
    if (kind === 'delete') {
      const result = await botApi<{ ok: true }>(t, `/api/servers/${serverId}/bots/${bot.id}`, { method: 'DELETE' });
      setBusy(false);
      setConfirm(null);
      if (!result.ok) return setNotice({ tone: 'danger', text: result.message });
      onRemoved(bot.id);
      return setNotice({ tone: 'success', text: t('bots.custom.deleted', { name: bot.name }) });
    }
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots/${bot.id}/token`, {
      method: kind === 'revoke' ? 'DELETE' : 'POST',
    });
    setBusy(false);
    setConfirm(null);
    if (!result.ok) return setNotice({ tone: 'danger', text: result.message });
    onChange(result.data.bot);
    if (kind === 'revoke') return setNotice({ tone: 'success', text: t('bots.custom.revoked', { name: bot.name }) });
    if (result.data.token) onToken({ botName: bot.name, token: result.data.token });
  }

  return (
    <>
      <Card className="mb-4">
        <h3 className="text-base font-semibold text-text-primary">{t('bots.custom.createTitle')}</h3>
        <div className="mt-4 grid gap-4">
          <Field label={t('bots.field.name')} hint={t('bots.custom.nameHint')}>
            {(id, hintId) => (
              <input
                id={id}
                aria-describedby={hintId}
                value={name}
                maxLength={BOT_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('bots.custom.namePlaceholder')}
                disabled={disabled || atLimit}
                className={inputClass}
              />
            )}
          </Field>
          <PermissionPicker value={permissions} onChange={setPermissions} disabled={disabled || atLimit} idPrefix="new-bot" />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            {t('bots.custom.count', { count: bots.length, max: MAX_CUSTOM_BOTS_PER_SERVER })}
          </p>
          <button
            type="button"
            onClick={() => void create()}
            disabled={disabled || atLimit || !name.trim() || createLocked}
            className={primaryButtonClass}
          >
            {busy ? t('bots.working') : t('bots.custom.create')}
          </button>
        </div>
        {canMutate && createLocked ? <EmailUnverifiedNotice action="createBot" className="mt-3" /> : null}
        {!canMutate ? <p className="mt-3 text-xs text-text-muted">{t('bots.cannotMutate')}</p> : null}
      </Card>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {bots.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-subtle p-6 text-center text-sm text-text-muted">
          {t('bots.custom.empty')}
        </p>
      ) : (
        <ul className="grid gap-3" aria-label={t('bots.custom.listLabel')}>
          {bots.map((bot) => {
            const isEditing = editing?.id === bot.id;
            return (
              <li key={bot.id} data-testid="custom-bot" className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <BotAvatar size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{bot.name}</span>
                      <BotBadge />
                      <TrustBadge level={bot.trustLevel} />
                      <span className={`text-xs font-medium ${bot.enabled ? 'text-success' : 'text-text-muted'}`}>
                        {bot.enabled ? t('bots.status.enabled') : t('bots.status.disabled')}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-muted">
                      {bot.tokenConfigured
                        ? t('bots.custom.tokenIssued', { date: formatDate(t, bot.tokenIssuedAt) ?? '—' })
                        : t('bots.custom.tokenNone')}
                      {' · '}
                      {bot.lastUsedAt
                        ? t('bots.custom.lastUsed', { date: formatDate(t, bot.lastUsedAt) ?? '' })
                        : t('bots.custom.neverUsed')}
                      {bot.createdBy?.name ? ` · ${t('bots.custom.createdBy', { name: bot.createdBy.name })}` : null}
                    </p>
                  </div>
                  <Switch
                    checked={bot.enabled}
                    onChange={(value) => void patch(bot, { enabled: value })}
                    label={t('bots.custom.toggle', { name: bot.name })}
                    disabled={disabled}
                  />
                </div>

                {isEditing ? (
                  <div className="mt-4 grid gap-4">
                    <Field label={t('bots.field.name')}>
                      {(id) => (
                        <input
                          id={id}
                          value={editing.name}
                          maxLength={BOT_NAME_MAX_LENGTH}
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                          disabled={disabled}
                          className={inputClass}
                        />
                      )}
                    </Field>
                    <PermissionPicker
                      value={editing.permissions}
                      onChange={(next) => setEditing({ ...editing, permissions: next })}
                      disabled={disabled}
                      idPrefix={`edit-${bot.id}`}
                    />
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setEditing(null)} disabled={busy} className={secondaryButtonClass}>
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={disabled || !editing.name.trim()}
                        className={primaryButtonClass}
                        onClick={async () => {
                          const ok = await patch(
                            bot,
                            { name: editing.name.trim(), permissions: editing.permissions },
                            t('bots.saved')
                          );
                          if (ok) setEditing(null);
                        }}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {bot.permissions.length === 0 ? (
                      <span className="text-xs text-text-muted">{t('bots.profile.noPermissions')}</span>
                    ) : (
                      bot.permissions.map((permission) => (
                        <span
                          key={permission}
                          className="rounded bg-surface-container px-2 py-1 text-[11px] text-text-secondary"
                        >
                          {permissionLabel(t, permission)}
                        </span>
                      ))
                    )}
                  </div>
                )}

                {!isEditing ? (
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={disabled}
                      onClick={() =>
                        setEditing({
                          id: bot.id,
                          name: bot.name,
                          permissions: bot.permissions.filter((p): p is BotPermissionId =>
                            (BOT_PERMISSIONS as readonly string[]).includes(p)
                          ),
                        })
                      }
                    >
                      {t('bots.custom.edit')}
                    </button>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={disabled}
                      onClick={() => (bot.tokenConfigured ? setConfirm({ kind: 'rotate', bot }) : void issueToken(bot))}
                    >
                      {bot.tokenConfigured ? t('bots.custom.rotate') : t('bots.custom.issue')}
                    </button>
                    {bot.tokenConfigured ? (
                      <button
                        type="button"
                        className={dangerButtonClass}
                        disabled={disabled}
                        onClick={() => setConfirm({ kind: 'revoke', bot })}
                      >
                        {t('bots.custom.revoke')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={dangerButtonClass}
                      disabled={disabled}
                      onClick={() => setConfirm({ kind: 'delete', bot })}
                    >
                      {t('bots.custom.delete')}
                    </button>
                  </div>
                ) : null}

                {serverId ? (
                  <BotIntegrations bot={bot} serverId={serverId} canMutate={canMutate} fallbackChannels={channels} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {confirm ? (
        <Dialog
          title={t(CONFIRM_KEYS[confirm.kind].title, { name: confirm.bot.name })}
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
                className={confirm.kind === 'rotate' ? primaryButtonClass : dangerButtonClass}
              >
                {busy ? t('bots.working') : t(CONFIRM_KEYS[confirm.kind].action)}
              </button>
            </>
          }
        >
          {t(CONFIRM_KEYS[confirm.kind].body, { name: confirm.bot.name })}
        </Dialog>
      ) : null}
    </>
  );
}
