'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import type { BotJson } from '@/lib/bots/admin';
import {
  getBotChannelAccess,
  getBotEventEndpoint,
  listBotCommands,
  patchBotCommand,
  putBotChannelAccess,
  reenableBotEventEndpoint,
  type AccessChannel,
  type BotChannelAccess,
  type BotCommandInfo,
  type BotEventEndpoint,
  type ChannelAccessMode,
  type RequestFailure,
} from '@/lib/bots/client-api';
import { describeFailure } from './api-client';
import { Alert, Switch, primaryButtonClass, secondaryButtonClass } from './ui';

/**
 * Bot API v2 settings for one custom bot (docs/BOT_API_V2.md §7):
 * - Channel access — every eligible channel (the v1 rule) or exactly the
 *   chosen ones. Role-gated channels can only be granted by someone who
 *   may (the server decides; the page explains).
 * - Commands — what the bot registered, with enable/disable and a channel
 *   restriction per command.
 * - Event endpoint — where the instance delivers the bot's events, and
 *   why deliveries stopped. Its signing secret is shown to the BOT through
 *   the API when it sets the URL, never here.
 *
 * Collapsed by default and loaded when opened: most bots never need it.
 */

type Notice = { tone: 'success' | 'danger'; text: string } | null;

/** Core permission codes with a label in the catalogue (`hub.servers.permission.<code>`). */
const CORE_PERMISSION_LABELS = new Set([
  'administrator',
  'manage_server',
  'manage_channels',
  'manage_roles',
  'kick_members',
  'ban_members',
  'create_invite',
  'send_messages',
  'manage_messages',
  'add_reactions',
  'connect_voice',
  'speak',
  'mute_members',
  'deafen_members',
  'view_audit_log',
  'start_activity',
]);

function corePermissionLabel(t: Translator, code: string): string {
  return CORE_PERMISSION_LABELS.has(code) ? t(`hub.servers.permission.${code}`) : code;
}

function formatDate(t: Translator, iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(t.locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function failureText(t: Translator, failure: RequestFailure): string {
  if (failure.code === 'network') return t('bots.error.network');
  if (failure.code === 'bad_response') return t('botAdmin.error.unexpected');
  return describeFailure(t, failure.status, failure.body as Parameters<typeof describeFailure>[2]);
}

const subsectionTitle = 'flex items-center gap-1.5 text-sm font-semibold text-text-primary';

export function BotIntegrations({
  bot,
  serverId,
  canMutate,
  fallbackChannels,
}: {
  bot: BotJson;
  serverId: string;
  canMutate: boolean;
  /** Ungated text channels from the page, used if the route does not list channels. */
  fallbackChannels: Array<{ id: string; name: string }>;
}) {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4 border-t border-border-subtle pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left text-sm font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden>
          {open ? 'expand_less' : 'expand_more'}
        </span>
        {t('botAdmin.toggle')}
      </button>
      {open ? (
        <div id={panelId} className="mt-3 grid gap-6">
          <BotIntegrationsBody bot={bot} serverId={serverId} canMutate={canMutate} fallbackChannels={fallbackChannels} />
        </div>
      ) : null}
    </div>
  );
}

function BotIntegrationsBody({
  bot,
  serverId,
  canMutate,
  fallbackChannels,
}: {
  bot: BotJson;
  serverId: string;
  canMutate: boolean;
  fallbackChannels: Array<{ id: string; name: string }>;
}) {
  const t = useT();
  const [access, setAccess] = useState<BotChannelAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getBotChannelAccess(serverId, bot.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setAccess(result.data);
      else setAccessError(failureText(t, result));
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, bot.id, t]);

  const channels: AccessChannel[] =
    access?.channels ??
    fallbackChannels.map((c) => ({ id: c.id, name: c.name, roleGated: false, grantable: true, reachable: null }));
  // What the bot reaches now — as the route says, else the chosen channels
  // or every ungated one.
  const reachable = channels.filter((c) =>
    c.reachable !== null ? c.reachable : access?.mode === 'selected' ? access.channelIds.includes(c.id) : !c.roleGated
  );

  return (
    <>
      <ChannelAccessSection
        bot={bot}
        serverId={serverId}
        canMutate={canMutate}
        access={access}
        loadError={accessError}
        channels={channels}
        onSaved={setAccess}
      />
      <CommandsSection bot={bot} serverId={serverId} canMutate={canMutate} reachable={reachable} />
      <EventEndpointSection bot={bot} serverId={serverId} canMutate={canMutate} />
    </>
  );
}

// ---------------------------------------------------------------------------

function ChannelAccessSection({
  bot,
  serverId,
  canMutate,
  access,
  loadError,
  channels,
  onSaved,
}: {
  bot: BotJson;
  serverId: string;
  canMutate: boolean;
  access: BotChannelAccess | null;
  loadError: string | null;
  channels: AccessChannel[];
  onSaved: (access: BotChannelAccess) => void;
}) {
  const t = useT();
  const titleId = useId();
  const [mode, setMode] = useState<ChannelAccessMode>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (!access) return;
    setMode(access.mode);
    setSelected(access.channelIds);
  }, [access]);

  const dirty =
    access !== null &&
    (mode !== access.mode ||
      (mode === 'selected' &&
        (selected.length !== access.channelIds.length || selected.some((id) => !access.channelIds.includes(id)))));
  const empty = mode === 'selected' && selected.length === 0;
  const disabled = !canMutate || saving || access === null;

  // Any edit makes the last notice stale: "Saved" next to "Choose at least
  // one channel." read as if the empty selection had been saved.
  function changeMode(next: ChannelAccessMode) {
    setNotice(null);
    setMode(next);
  }
  function toggleChannel(channelId: string, checked: boolean) {
    setNotice(null);
    setSelected((current) => (checked ? [...current, channelId] : current.filter((id) => id !== channelId)));
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    const result = await putBotChannelAccess(serverId, bot.id, { mode, channelIds: selected });
    setSaving(false);
    if (!result.ok) {
      const text =
        result.code === 'cannot_grant_channel'
          ? t('botAdmin.access.notGrantableError')
          : result.code === 'cannot_change_hidden_access'
            ? t('botAdmin.access.hiddenError')
            : result.code === 'invalid_channel'
              ? t('botAdmin.access.invalidChannel')
              : failureText(t, result);
      setNotice({ tone: 'danger', text });
      return;
    }
    onSaved(result.data);
    setNotice({ tone: 'success', text: t('botAdmin.access.saved', { name: bot.name }) });
  }

  return (
    <section aria-labelledby={titleId} data-testid="bot-channel-access">
      <h4 id={titleId} className={subsectionTitle}>
        <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>tag</span>
        {t('botAdmin.access.title')}
      </h4>
      <p className="mt-1 text-xs text-text-muted">{t('botAdmin.access.intro')}</p>

      {loadError ? <div className="mt-3"><Alert tone="danger">{loadError}</Alert></div> : null}
      {!access && !loadError ? <p className="mt-3 text-sm text-text-muted">{t('common.loading')}</p> : null}

      {access ? (
        <>
          <fieldset className="mt-3 grid gap-2">
            <legend className="sr-only">{t('botAdmin.access.title')}</legend>
            {(['all', 'selected'] as const).map((value) => (
              <label key={value} className="flex cursor-pointer items-start gap-2 text-sm text-text-primary">
                <input
                  type="radio"
                  name={`${titleId}-mode`}
                  value={value}
                  checked={mode === value}
                  disabled={disabled}
                  onChange={() => changeMode(value)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  {value === 'all' ? t('botAdmin.access.all') : t('botAdmin.access.selected')}
                  <span className="block text-xs text-text-muted">
                    {value === 'all' ? t('botAdmin.access.allHint') : t('botAdmin.access.selectedHint')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {access.hiddenGrantCount > 0 ? (
            <p className="mt-2 flex items-start gap-1 text-xs text-text-muted">
              <span className="material-symbols-outlined text-[14px]" aria-hidden>lock</span>
              {t('botAdmin.access.hiddenGrants', { count: access.hiddenGrantCount })}
            </p>
          ) : null}

          {mode === 'selected' ? (
            <fieldset className="mt-3 rounded-lg border border-border-subtle p-3">
              <legend className="px-1 text-xs font-medium text-text-secondary">{t('botAdmin.access.channelsLegend')}</legend>
              {channels.length === 0 ? (
                <p className="text-sm text-text-muted">{t('botAdmin.access.noChannels')}</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {channels.map((channel) => {
                    const checked = selected.includes(channel.id);
                    // Only Manage Channels may ADD a private channel; one it already has
                    // can be kept or removed by any bot manager.
                    const locked = !channel.grantable && !(access?.channelIds ?? []).includes(channel.id);
                    const hintId = `${titleId}-${channel.id}-hint`;
                    return (
                      <li key={channel.id}>
                        <label className={`flex items-start gap-2 text-sm ${locked ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer text-text-primary'}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled || locked}
                            aria-describedby={channel.roleGated ? hintId : undefined}
                            onChange={(event) => toggleChannel(channel.id, event.target.checked)}
                            className="mt-0.5 size-4 accent-primary"
                          />
                          <span className="min-w-0">
                            <span className="break-words">#{channel.name}</span>
                            {channel.roleGated ? (
                              <span id={hintId} className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                                <span className="material-symbols-outlined text-[14px]" aria-hidden>lock</span>
                                {locked ? t('botAdmin.access.gatedLocked') : t('botAdmin.access.gated')}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {empty ? <p className="mt-2 text-xs text-danger">{t('botAdmin.access.chooseOne')}</p> : null}
            </fieldset>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {notice ? (
              <p role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mr-auto text-xs ${notice.tone === 'danger' ? 'text-danger' : 'text-success'}`}>
                {notice.text}
              </p>
            ) : null}
            <button type="button" onClick={() => void save()} disabled={disabled || !dirty || empty} className={primaryButtonClass}>
              {saving ? t('bots.working') : t('botAdmin.access.save')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function CommandsSection({
  bot,
  serverId,
  canMutate,
  reachable,
}: {
  bot: BotJson;
  serverId: string;
  canMutate: boolean;
  reachable: AccessChannel[];
}) {
  const t = useT();
  const titleId = useId();
  const [commands, setCommands] = useState<BotCommandInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditingState] = useState<{ id: string; all: boolean; channelIds: string[] } | null>(null);
  const hasPermission = bot.permissions.includes('slash_commands');
  // Editing a command's channels makes the last notice stale (see ChannelAccessSection).
  function setEditing(next: { id: string; all: boolean; channelIds: string[] } | null) {
    setNotice(null);
    setEditingState(next);
  }

  const load = useCallback(() => {
    setLoadError(null);
    void listBotCommands(serverId, bot.id).then((result) => {
      if (result.ok) setCommands(result.data);
      else setLoadError(failureText(t, result));
    });
  }, [serverId, bot.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(command: BotCommandInfo, body: { enabled?: boolean; channelIds?: string[] | null }, done: string) {
    setBusyId(command.id);
    setNotice(null);
    const result = await patchBotCommand(serverId, bot.id, command.id, body);
    setBusyId(null);
    if (!result.ok) {
      setNotice({ tone: 'danger', text: failureText(t, result) });
      return false;
    }
    setCommands((current) => current?.map((c) => (c.id === command.id ? result.data : c)) ?? null);
    setNotice({ tone: 'success', text: done });
    return true;
  }

  /** Where the bot itself lets the command run: its reachable channels, narrowed by its own list. */
  const botChannels = (command: BotCommandInfo) =>
    command.channelIds ? reachable.filter((c) => command.channelIds!.includes(c.id)) : reachable;
  function channelSummary(command: BotCommandInfo): string {
    if (!command.channelIds && !command.adminChannelIds) return t('botAdmin.commands.everyChannel');
    // Both lists apply: the bot's own and the managers'.
    const names = botChannels(command)
      .filter((c) => !command.adminChannelIds || command.adminChannelIds.includes(c.id))
      .map((c) => c.name);
    if (names.length === 0) return t('botAdmin.commands.noReachableChannel');
    return names.map((n) => `#${n}`).join(', ');
  }

  return (
    <section aria-labelledby={titleId} data-testid="bot-commands">
      <h4 id={titleId} className={subsectionTitle}>
        <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>terminal</span>
        {t('botAdmin.commands.title')}
      </h4>
      <p className="mt-1 text-xs text-text-muted">{t('botAdmin.commands.intro')}</p>
      {!hasPermission ? (
        <p className="mt-2 text-xs text-text-secondary">{t('botAdmin.commands.needsPermission')}</p>
      ) : null}

      {loadError ? (
        <div className="mt-3">
          <Alert tone="danger">{loadError}</Alert>
          <button type="button" onClick={load} className={secondaryButtonClass}>
            {t('botAdmin.retry')}
          </button>
        </div>
      ) : null}
      {commands === null && !loadError ? <p className="mt-3 text-sm text-text-muted">{t('common.loading')}</p> : null}
      {commands && commands.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border-subtle p-4 text-center text-sm text-text-muted">
          {t('botAdmin.commands.empty')}
        </p>
      ) : null}

      {commands && commands.length > 0 ? (
        <ul className="mt-3 grid gap-2" aria-label={t('botAdmin.commands.listLabel', { name: bot.name })}>
          {commands.map((command) => {
            const isEditing = editing?.id === command.id;
            const busy = busyId === command.id;
            return (
              <li key={command.id} data-testid="bot-command" className="rounded-lg border border-border-subtle bg-surface-container/40 p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-sm font-semibold text-text-primary">/{command.name}</span>
                      <span className="text-xs text-text-secondary">{command.description}</span>
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('botAdmin.commands.options', { count: command.options.length })}
                      {' · '}
                      {channelSummary(command)}
                      {command.requiredPermission
                        ? ` · ${t('botAdmin.commands.requires', { permission: corePermissionLabel(t, command.requiredPermission) })}`
                        : null}
                    </p>
                  </div>
                  <span className={`text-xs font-medium ${command.enabled ? 'text-success' : 'text-text-muted'}`}>
                    {command.enabled ? t('bots.status.enabled') : t('bots.status.disabled')}
                  </span>
                  <Switch
                    checked={command.enabled}
                    disabled={!canMutate || busy}
                    label={t('botAdmin.commands.toggle', { command: command.name })}
                    onChange={(value) =>
                      void patch(
                        command,
                        { enabled: value },
                        value
                          ? t('botAdmin.commands.enabledNotice', { command: command.name })
                          : t('botAdmin.commands.disabledNotice', { command: command.name })
                      )
                    }
                  />
                </div>

                {isEditing ? (
                  <fieldset className="mt-3 rounded-lg border border-border-subtle p-3">
                    <legend className="px-1 text-xs font-medium text-text-secondary">
                      {t('botAdmin.commands.channelsLegend', { command: command.name })}
                    </legend>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                      <input
                        type="radio"
                        name={`${titleId}-${command.id}`}
                        checked={editing.all}
                        onChange={() => setEditing({ ...editing, all: true })}
                        className="size-4 accent-primary"
                      />
                      {t('botAdmin.commands.everyChannel')}
                    </label>
                    <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                      <input
                        type="radio"
                        name={`${titleId}-${command.id}`}
                        checked={!editing.all}
                        onChange={() => setEditing({ ...editing, all: false })}
                        className="size-4 accent-primary"
                      />
                      {t('botAdmin.commands.onlyThese')}
                    </label>
                    {!editing.all ? (
                      <ul className="mt-2 grid gap-1.5 pl-6 sm:grid-cols-2">
                        {botChannels(command).map((channel) => (
                          <li key={channel.id}>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                              <input
                                type="checkbox"
                                checked={editing.channelIds.includes(channel.id)}
                                onChange={(event) =>
                                  setEditing({
                                    ...editing,
                                    channelIds: event.target.checked
                                      ? [...editing.channelIds, channel.id]
                                      : editing.channelIds.filter((id) => id !== channel.id),
                                  })
                                }
                                className="size-4 accent-primary"
                              />
                              #{channel.name}
                            </label>
                          </li>
                        ))}
                        {botChannels(command).length === 0 ? (
                          <li className="text-sm text-text-muted">{t('botAdmin.access.noChannels')}</li>
                        ) : null}
                      </ul>
                    ) : null}
                    {!editing.all && editing.channelIds.length === 0 ? (
                      <p className="mt-2 text-xs text-danger">{t('botAdmin.access.chooseOne')}</p>
                    ) : null}
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" onClick={() => setEditing(null)} className={secondaryButtonClass}>
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={busy || (!editing.all && editing.channelIds.length === 0)}
                        className={primaryButtonClass}
                        onClick={async () => {
                          const ok = await patch(
                            command,
                            { channelIds: editing.all ? null : editing.channelIds },
                            t('botAdmin.commands.channelsSaved', { command: command.name })
                          );
                          // Close the editor but keep the "saved" notice.
                          if (ok) setEditingState(null);
                        }}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  </fieldset>
                ) : (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={!canMutate || busy}
                      className={secondaryButtonClass}
                      onClick={() =>
                        setEditing({ id: command.id, all: !command.adminChannelIds, channelIds: command.adminChannelIds ?? [] })
                      }
                    >
                      {t('botAdmin.commands.editChannels')}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {notice ? (
        <p role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mt-2 text-xs ${notice.tone === 'danger' ? 'text-danger' : 'text-success'}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Reasons the delivery worker gives for switching an endpoint off. */
function disabledReasonText(t: Translator, reason: string): string {
  switch (reason) {
    case 'too_many_failures':
    case 'consecutive_failures':
    case 'failures':
      return t('botAdmin.endpoint.reason.failures');
    case 'unsafe_address':
    case 'ssrf':
    case 'private_address':
      return t('botAdmin.endpoint.reason.unsafe');
    case 'manual':
      return t('botAdmin.endpoint.reason.manual');
    default:
      return reason;
  }
}

function EventEndpointSection({ bot, serverId, canMutate }: { bot: BotJson; serverId: string; canMutate: boolean }) {
  const t = useT();
  const titleId = useId();
  const [endpoint, setEndpoint] = useState<BotEventEndpoint | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const hasPermission = bot.permissions.includes('receive_events');

  useEffect(() => {
    let cancelled = false;
    void getBotEventEndpoint(serverId, bot.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setEndpoint(result.data.endpoint);
      else setLoadError(failureText(t, result));
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, bot.id, t]);

  async function reenable() {
    setBusy(true);
    setNotice(null);
    const result = await reenableBotEventEndpoint(serverId, bot.id);
    setBusy(false);
    if (!result.ok) return setNotice({ tone: 'danger', text: failureText(t, result) });
    setEndpoint(result.data.endpoint);
    setNotice({ tone: 'success', text: t('botAdmin.endpoint.reenabled') });
  }

  return (
    <section aria-labelledby={titleId} data-testid="bot-event-endpoint">
      <h4 id={titleId} className={subsectionTitle}>
        <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>send</span>
        {t('botAdmin.endpoint.title')}
      </h4>
      <p className="mt-1 text-xs text-text-muted">{t('botAdmin.endpoint.intro')}</p>
      {!hasPermission ? <p className="mt-2 text-xs text-text-secondary">{t('botAdmin.endpoint.needsPermission')}</p> : null}

      {loadError ? <div className="mt-3"><Alert tone="danger">{loadError}</Alert></div> : null}
      {endpoint === undefined && !loadError ? <p className="mt-3 text-sm text-text-muted">{t('common.loading')}</p> : null}
      {endpoint === null ? (
        <p className="mt-3 rounded-lg border border-dashed border-border-subtle p-4 text-center text-sm text-text-muted">
          {t('botAdmin.endpoint.none')}
        </p>
      ) : null}

      {endpoint ? (
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-container/40 p-3">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.url')}</dt>
            <dd className="break-all font-mono text-xs text-text-primary">{endpoint.url}</dd>

            <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.status')}</dt>
            <dd>
              <span
                data-testid="endpoint-status"
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium ${
                  endpoint.enabled ? 'border-success/40 text-success' : 'border-danger/40 text-danger'
                }`}
              >
                <span className="material-symbols-outlined text-[13px]" aria-hidden>
                  {endpoint.enabled ? 'check_circle' : 'block'}
                </span>
                {endpoint.enabled ? t('botAdmin.endpoint.active') : t('botAdmin.endpoint.disabled')}
              </span>
            </dd>

            <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.lastDelivery')}</dt>
            <dd className="text-text-primary">{formatDate(t, endpoint.lastDeliveryAt) ?? t('botAdmin.endpoint.never')}</dd>

            <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.lastStatus')}</dt>
            <dd className="text-text-primary">
              {endpoint.lastStatus === null
                ? '—'
                : endpoint.lastStatus === 0
                  ? t('botAdmin.endpoint.noResponse')
                  : t('botAdmin.endpoint.httpStatus', { status: endpoint.lastStatus })}
            </dd>

            <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.failures')}</dt>
            <dd className={endpoint.failureCount > 0 ? 'text-danger' : 'text-text-primary'}>
              {endpoint.failureCount.toLocaleString(t.locale)}
            </dd>

            {endpoint.events.length > 0 ? (
              <>
                <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.events')}</dt>
                <dd className="flex flex-wrap gap-1">
                  {endpoint.events.map((event) => (
                    <span key={event} className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                      {event}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}

            {endpoint.disabledReason ? (
              <>
                <dt className="text-xs font-medium text-text-secondary">{t('botAdmin.endpoint.reasonLabel')}</dt>
                <dd className="text-danger">{disabledReasonText(t, endpoint.disabledReason)}</dd>
              </>
            ) : null}
          </dl>

          {!endpoint.enabled ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
              <p className="text-xs text-text-muted">{t('botAdmin.endpoint.reenableHint')}</p>
              <button type="button" onClick={() => void reenable()} disabled={!canMutate || busy} className={primaryButtonClass}>
                {busy ? t('bots.working') : t('botAdmin.endpoint.reenable')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mt-2 text-xs ${notice.tone === 'danger' ? 'text-danger' : 'text-success'}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
