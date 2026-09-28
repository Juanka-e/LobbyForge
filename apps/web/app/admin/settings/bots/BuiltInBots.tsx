'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import type { BotJson } from '@/lib/bots/admin';
import {
  DEFAULT_MODERATION_SETTINGS,
  MODERATION_LIMITS,
  TEMPLATE_MAX_LENGTH,
  normalizeDomain,
  parseModerationSettings,
  parseWelcomeSettings,
  type LinkPolicy,
} from '@/lib/bots/settings';
import { BotAvatar, BotBadge, TrustBadge } from '@/app/lobby/BotIdentity';
import { botApi, type BotResponse } from './api-client';
import { Alert, Card, Field, Switch, inputClass, primaryButtonClass } from './ui';

interface CardProps {
  bot: BotJson | null;
  serverId: string | null;
  canMutate: boolean;
  onSaved: (bot: BotJson) => void;
}

type Notice = { tone: 'success' | 'danger'; text: string } | null;

function fillPreview(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [name, value] of Object.entries(values)) out = out.split(`{${name}}`).join(value);
  return out;
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function BuiltInHeader({
  title,
  description,
  bot,
  enabled,
  onToggle,
  toggleLabel,
  disabled,
}: {
  title: string;
  description: string;
  bot: BotJson | null;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  toggleLabel: string;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <header className="flex flex-wrap items-start gap-3">
      <BotAvatar size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-text-primary">{bot?.name ?? title}</h3>
          <BotBadge />
          <TrustBadge level="official" />
          <span className={`text-xs font-medium ${enabled ? 'text-success' : 'text-text-muted'}`}>
            {enabled ? t('bots.status.enabled') : bot ? t('bots.status.disabled') : t('bots.status.notSetUp')}
          </span>
        </div>
        <p className="mt-1 text-sm text-text-secondary">{description}</p>
      </div>
      <Switch checked={enabled} onChange={onToggle} label={toggleLabel} disabled={disabled} />
    </header>
  );
}

export function WelcomeBotCard({
  bot,
  serverId,
  serverName,
  channels,
  canMutate,
  onSaved,
}: CardProps & { serverName: string; channels: Array<{ id: string; name: string }> }) {
  const t = useT();
  const stored = parseWelcomeSettings(bot?.settings ?? {});
  const [enabled, setEnabled] = useState(bot?.enabled ?? false);
  const [name, setName] = useState(bot?.name ?? t('bots.welcome.defaultName'));
  const [channelId, setChannelId] = useState(stored.channelId ?? '');
  const [template, setTemplate] = useState(stored.template ?? t('bots.welcome.defaultTemplate'));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function save(nextEnabled: boolean) {
    if (!serverId) return;
    setSaving(true);
    setNotice(null);
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots/builtin/welcome`, {
      method: 'PUT',
      body: {
        enabled: nextEnabled,
        name: name.trim() || t('bots.welcome.defaultName'),
        settings: { channelId: channelId || null, template: template.trim() || null },
      },
    });
    setSaving(false);
    if (!result.ok) {
      setNotice({ tone: 'danger', text: result.message });
      return;
    }
    setEnabled(result.data.bot.enabled);
    onSaved(result.data.bot);
    setNotice({ tone: 'success', text: t('bots.saved') });
  }

  const disabled = !canMutate || !serverId || saving;
  const preview = fillPreview(template.trim() || t('bots.welcome.defaultTemplate'), {
    user: t('bots.welcome.previewUser'),
    server: serverName || t('bots.welcome.previewServer'),
  });

  return (
    <Card testId="welcome-bot-card">
      <BuiltInHeader
        title={t('bots.welcome.defaultName')}
        description={t('bots.welcome.description')}
        bot={bot}
        enabled={enabled}
        onToggle={(value) => void save(value)}
        toggleLabel={t('bots.welcome.toggle')}
        disabled={disabled}
      />
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label={t('bots.field.name')}>
          {(id) => (
            <input
              id={id}
              value={name}
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
              disabled={disabled}
              className={inputClass}
            />
          )}
        </Field>
        <Field label={t('bots.welcome.channel')} hint={t('bots.welcome.channelHint')}>
          {(id, hintId) => (
            <select
              id={id}
              aria-describedby={hintId}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              disabled={disabled}
              className={inputClass}
            >
              <option value="">{t('bots.welcome.channelDefault')}</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="mt-4">
        <Field
          label={t('bots.welcome.template')}
          hint={rich(t('bots.welcome.templateHint'), {
            user: <code className="rounded bg-surface-container px-1">{'{user}'}</code>,
            server: <code className="rounded bg-surface-container px-1">{'{server}'}</code>,
          })}
        >
          {(id, hintId) => (
            <textarea
              id={id}
              aria-describedby={hintId}
              rows={3}
              maxLength={TEMPLATE_MAX_LENGTH}
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              disabled={disabled}
              className={inputClass}
            />
          )}
        </Field>
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-container/40 p-3">
          <p className="text-xs font-medium text-text-muted">{t('bots.welcome.preview')}</p>
          <div className="mt-2 flex items-start gap-3">
            <BotAvatar size="sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{name.trim() || t('bots.welcome.defaultName')}</span>
                <BotBadge />
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-text-secondary">{preview}</p>
            </div>
          </div>
        </div>
      </div>
      {notice ? <div className="mt-4"><Alert tone={notice.tone}>{notice.text}</Alert></div> : null}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => void save(enabled)} disabled={disabled} className={primaryButtonClass}>
          {saving ? t('bots.saving') : t('common.save')}
        </button>
      </div>
    </Card>
  );
}

export function ModerationBotCard({ bot, serverId, canMutate, onSaved }: CardProps) {
  const t = useT();
  const stored = useMemo(() => parseModerationSettings(bot?.settings ?? {}), [bot?.settings]);
  const d = DEFAULT_MODERATION_SETTINGS;
  const [enabled, setEnabled] = useState(bot?.enabled ?? false);
  const [name, setName] = useState(bot?.name ?? t('bots.moderation.defaultName'));
  const [words, setWords] = useState(stored.blockedWords.join('\n'));
  const [linkPolicy, setLinkPolicy] = useState<LinkPolicy>(stored.linkPolicy);
  const [domains, setDomains] = useState(stored.allowedDomains.join('\n'));
  const [maxMentions, setMaxMentions] = useState(String(stored.maxMentions));
  const [floodOn, setFloodOn] = useState(stored.flood !== null);
  const [floodMax, setFloodMax] = useState(String(stored.flood?.max ?? d.flood!.max));
  const [floodWindow, setFloodWindow] = useState(String(stored.flood?.windowSeconds ?? d.flood!.windowSeconds));
  const [repeatOn, setRepeatOn] = useState(stored.repeat !== null);
  const [repeatMax, setRepeatMax] = useState(String(stored.repeat?.max ?? d.repeat!.max));
  const [repeatWindow, setRepeatWindow] = useState(String(stored.repeat?.windowSeconds ?? d.repeat!.windowSeconds));
  const [exemptStaff, setExemptStaff] = useState(stored.exemptStaff);
  const [postNotice, setPostNotice] = useState(stored.postNotice);
  const [noticeTemplate, setNoticeTemplate] = useState(stored.noticeTemplate ?? t('bots.moderation.defaultNotice'));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  function buildSettings(): { ok: true; settings: Record<string, unknown> } | { ok: false; message: string } {
    const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
    const blockedWords = lines(words);
    if (blockedWords.length > MODERATION_LIMITS.blockedWords) {
      return { ok: false, message: t('bots.moderation.tooManyWords', { count: MODERATION_LIMITS.blockedWords }) };
    }
    const rawDomains = lines(domains);
    const invalid = rawDomains.filter((domain) => !normalizeDomain(domain));
    if (invalid.length > 0) {
      return { ok: false, message: t('bots.moderation.invalidDomains', { domains: invalid.join(', ') }) };
    }
    if (rawDomains.length > MODERATION_LIMITS.allowedDomains) {
      return { ok: false, message: t('bots.moderation.tooManyDomains', { count: MODERATION_LIMITS.allowedDomains }) };
    }
    return {
      ok: true,
      settings: {
        blockedWords: blockedWords.map((word) => word.slice(0, MODERATION_LIMITS.blockedWordLength)),
        linkPolicy,
        allowedDomains: rawDomains.map((domain) => normalizeDomain(domain)!),
        maxMentions: clampInt(maxMentions, 0, MODERATION_LIMITS.maxMentions, d.maxMentions),
        flood: floodOn
          ? {
              max: clampInt(floodMax, MODERATION_LIMITS.floodMax.min, MODERATION_LIMITS.floodMax.max, d.flood!.max),
              windowSeconds: clampInt(floodWindow, MODERATION_LIMITS.floodWindow.min, MODERATION_LIMITS.floodWindow.max, d.flood!.windowSeconds),
            }
          : null,
        repeat: repeatOn
          ? {
              max: clampInt(repeatMax, MODERATION_LIMITS.repeatMax.min, MODERATION_LIMITS.repeatMax.max, d.repeat!.max),
              windowSeconds: clampInt(repeatWindow, MODERATION_LIMITS.repeatWindow.min, MODERATION_LIMITS.repeatWindow.max, d.repeat!.windowSeconds),
            }
          : null,
        exemptStaff,
        postNotice,
        noticeTemplate: noticeTemplate.trim() || null,
      },
    };
  }

  async function save(nextEnabled: boolean) {
    if (!serverId) return;
    const built = buildSettings();
    if (!built.ok) {
      setNotice({ tone: 'danger', text: built.message });
      return;
    }
    setSaving(true);
    setNotice(null);
    const result = await botApi<BotResponse>(t, `/api/servers/${serverId}/bots/builtin/moderation`, {
      method: 'PUT',
      body: {
        enabled: nextEnabled,
        name: name.trim() || t('bots.moderation.defaultName'),
        settings: built.settings,
      },
    });
    setSaving(false);
    if (!result.ok) {
      setNotice({ tone: 'danger', text: result.message });
      return;
    }
    setEnabled(result.data.bot.enabled);
    onSaved(result.data.bot);
    setNotice({ tone: 'success', text: t('bots.saved') });
  }

  const disabled = !canMutate || !serverId || saving;
  const numberClass = `${inputClass} w-24`;

  return (
    <Card testId="moderation-bot-card">
      <BuiltInHeader
        title={t('bots.moderation.defaultName')}
        description={t('bots.moderation.description')}
        bot={bot}
        enabled={enabled}
        onToggle={(value) => void save(value)}
        toggleLabel={t('bots.moderation.toggle')}
        disabled={disabled}
      />

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label={t('bots.field.name')}>
          {(id) => (
            <input id={id} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} disabled={disabled} className={inputClass} />
          )}
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label={t('bots.moderation.blockedWords')}
          hint={t('bots.moderation.blockedWordsHint')}
        >
          {(id, hintId) => (
            <textarea
              id={id}
              aria-describedby={hintId}
              rows={5}
              value={words}
              onChange={(event) => setWords(event.target.value)}
              disabled={disabled}
              className={`${inputClass} font-mono`}
              spellCheck={false}
            />
          )}
        </Field>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label={t('bots.moderation.linkPolicy')}>
          {(id) => (
            <select
              id={id}
              value={linkPolicy}
              onChange={(event) => setLinkPolicy(event.target.value as LinkPolicy)}
              disabled={disabled}
              className={inputClass}
            >
              <option value="allow">{t('bots.moderation.link.allow')}</option>
              <option value="block">{t('bots.moderation.link.block')}</option>
              <option value="allowlist">{t('bots.moderation.link.allowlist')}</option>
            </select>
          )}
        </Field>
        <Field label={t('bots.moderation.maxMentions')} hint={t('bots.moderation.maxMentionsHint')}>
          {(id, hintId) => (
            <input
              id={id}
              aria-describedby={hintId}
              type="number"
              min={0}
              max={MODERATION_LIMITS.maxMentions}
              value={maxMentions}
              onChange={(event) => setMaxMentions(event.target.value)}
              disabled={disabled}
              className={numberClass}
            />
          )}
        </Field>
      </div>

      {linkPolicy === 'allowlist' ? (
        <div className="mt-4">
          <Field label={t('bots.moderation.allowedDomains')} hint={t('bots.moderation.allowedDomainsHint')}>
            {(id, hintId) => (
              <textarea
                id={id}
                aria-describedby={hintId}
                rows={3}
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                disabled={disabled}
                className={`${inputClass} font-mono`}
                spellCheck={false}
              />
            )}
          </Field>
        </div>
      ) : null}

      <div className="mt-5 divide-y divide-border-subtle rounded-lg border border-border-subtle">
        <RateRuleRow
          title={t('bots.moderation.flood')}
          description={t('bots.moderation.floodHint')}
          on={floodOn}
          onToggle={setFloodOn}
          max={floodMax}
          onMax={setFloodMax}
          windowSeconds={floodWindow}
          onWindow={setFloodWindow}
          limits={{ max: MODERATION_LIMITS.floodMax, window: MODERATION_LIMITS.floodWindow }}
          disabled={disabled}
        />
        <RateRuleRow
          title={t('bots.moderation.repeat')}
          description={t('bots.moderation.repeatHint')}
          on={repeatOn}
          onToggle={setRepeatOn}
          max={repeatMax}
          onMax={setRepeatMax}
          windowSeconds={repeatWindow}
          onWindow={setRepeatWindow}
          limits={{ max: MODERATION_LIMITS.repeatMax, window: MODERATION_LIMITS.repeatWindow }}
          disabled={disabled}
        />
        <ToggleLine
          title={t('bots.moderation.exemptStaff')}
          description={t('bots.moderation.exemptStaffHint')}
          checked={exemptStaff}
          onChange={setExemptStaff}
          disabled={disabled}
        />
        <ToggleLine
          title={t('bots.moderation.postNotice')}
          description={t('bots.moderation.postNoticeHint')}
          checked={postNotice}
          onChange={setPostNotice}
          disabled={disabled}
        />
      </div>

      {postNotice ? (
        <div className="mt-4">
          <Field
            label={t('bots.moderation.noticeTemplate')}
            hint={rich(t('bots.moderation.noticeTemplateHint'), {
              user: <code className="rounded bg-surface-container px-1">{'{user}'}</code>,
            })}
          >
            {(id, hintId) => (
              <textarea
                id={id}
                aria-describedby={hintId}
                rows={2}
                maxLength={TEMPLATE_MAX_LENGTH}
                value={noticeTemplate}
                onChange={(event) => setNoticeTemplate(event.target.value)}
                disabled={disabled}
                className={inputClass}
              />
            )}
          </Field>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-text-muted">{t('bots.moderation.auditNote')}</p>
      {notice ? <div className="mt-4"><Alert tone={notice.tone}>{notice.text}</Alert></div> : null}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => void save(enabled)} disabled={disabled} className={primaryButtonClass}>
          {saving ? t('bots.saving') : t('common.save')}
        </button>
      </div>
    </Card>
  );
}

function ToggleLine({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

function RateRuleRow({
  title,
  description,
  on,
  onToggle,
  max,
  onMax,
  windowSeconds,
  onWindow,
  limits,
  disabled,
}: {
  title: string;
  description: string;
  on: boolean;
  onToggle: (value: boolean) => void;
  max: string;
  onMax: (value: string) => void;
  windowSeconds: string;
  onWindow: (value: string) => void;
  limits: { max: { min: number; max: number }; window: { min: number; max: number } };
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-primary">{title}</p>
          <p className="mt-0.5 text-xs text-text-muted">{description}</p>
        </div>
        <Switch checked={on} onChange={onToggle} label={title} disabled={disabled} />
      </div>
      {on ? (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Field label={t('bots.moderation.rateMax')}>
            {(id) => (
              <input
                id={id}
                type="number"
                min={limits.max.min}
                max={limits.max.max}
                value={max}
                onChange={(event) => onMax(event.target.value)}
                disabled={disabled}
                className={`${inputClass} w-24`}
              />
            )}
          </Field>
          <Field label={t('bots.moderation.rateWindow')}>
            {(id) => (
              <input
                id={id}
                type="number"
                min={limits.window.min}
                max={limits.window.max}
                value={windowSeconds}
                onChange={(event) => onWindow(event.target.value)}
                disabled={disabled}
                className={`${inputClass} w-24`}
              />
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}
