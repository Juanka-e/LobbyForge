'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import {
  STRING_OPTION_MAX_LENGTH,
  checkOptionValues,
  type ChannelCommand,
  type CommandOption,
  type OptionError,
  type RawOptionValue,
} from '@/lib/bots/command-options';
import { invalidateChannelCommands, invokeCommand, invokeErrorKey, type InvokedInteraction } from '@/lib/bots/client-api';
import { RESTRICTED_ACTION_KEYS } from '@/components/email-verification/email-status';
import { handleEmailUnverified } from '@/components/email-verification/email-status-store';
import { moderationBlockedMessageKey } from '@/lib/bots/catalog';
import { BotBadge } from '../BotIdentity';
import type { MentionUser } from '../MentionInput';
import { SearchSelect } from './SearchSelect';

/**
 * The option fields of the slash command picked in the composer (BOT_API_V2
 * §3.1, §3.3). Replaces the message input until the command is run or
 * cancelled: Enter runs it, Escape cancels. Required options and ranges
 * are checked here first; the server checks everything again.
 */

export interface ComposerChannel {
  id: string;
  name: string;
  category: 'text' | 'voice';
}

/** Refusals that mean the cached command list is out of date. */
const STALE_LIST_CODES = new Set(['command_not_found', 'command_disabled', 'command_not_available', 'bot_unavailable', 'missing_permission']);

function optionErrorText(t: Translator, error: OptionError): string {
  switch (error.code) {
    case 'required':
      return t('interactions.form.error.required');
    case 'integer':
      return t('interactions.form.error.integer');
    case 'number':
      return t('interactions.form.error.number');
    case 'min':
      return t('interactions.form.error.min', { min: error.min });
    case 'max':
      return t('interactions.form.error.max', { max: error.max });
    case 'too_long':
      return t('interactions.form.error.tooLong', { max: error.max });
    case 'choice':
      return t('interactions.form.error.choice');
    default:
      return t('interactions.form.error.server');
  }
}

function rangeHint(t: Translator, option: CommandOption): string | null {
  if (option.type !== 'integer' && option.type !== 'number') return null;
  if (option.min !== undefined && option.max !== undefined) return t('interactions.form.range', { min: option.min, max: option.max });
  if (option.min !== undefined) return t('interactions.form.atLeast', { min: option.min });
  if (option.max !== undefined) return t('interactions.form.atMost', { max: option.max });
  return null;
}

const fieldClass = (invalid: boolean) =>
  `w-full rounded-md border bg-surface-raised px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary ${
    invalid ? 'border-danger' : 'border-border-strong focus:border-primary'
  }`;

export function SlashCommandForm({
  command,
  serverId,
  channelId,
  members,
  channels,
  onCancel,
  onInvoked,
}: {
  command: ChannelCommand;
  serverId: string;
  channelId: string;
  members: MentionUser[];
  channels: ComposerChannel[];
  onCancel: () => void;
  onInvoked: (interaction: InvokedInteraction) => void;
}) {
  const t = useT();
  const titleId = useId();
  const baseId = useId();
  const [values, setValues] = useState<Record<string, RawOptionValue>>(() => {
    const initial: Record<string, RawOptionValue> = {};
    for (const option of command.options) if (option.type === 'boolean' && option.required) initial[option.name] = false;
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fields = useRef(new Map<string, HTMLElement>());
  const runButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const first = command.options[0];
    const el = first ? fields.current.get(first.name) : runButton.current;
    el?.focus();
  }, [command]);

  function register(name: string) {
    return (el: HTMLElement | null) => {
      if (el) fields.current.set(name, el);
      else fields.current.delete(name);
    };
  }

  function setValue(name: string, value: RawOptionValue) {
    setValues((current) => ({ ...current, [name]: value }));
    if (errors[name]) setErrors(({ [name]: _removed, ...rest }) => rest);
  }

  function focusFirstInvalid(names: string[]) {
    const first = command.options.find((option) => names.includes(option.name));
    if (first) fields.current.get(first.name)?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const check = checkOptionValues(command.options, values);
    const invalid = Object.keys(check.errors);
    if (invalid.length > 0) {
      setErrors(Object.fromEntries(Object.entries(check.errors).map(([name, error]) => [name, optionErrorText(t, error)])));
      setServerError(null);
      focusFirstInvalid(invalid);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    const result = await invokeCommand(serverId, channelId, command.id, check.values);
    setSubmitting(false);
    if (result.ok) {
      onInvoked(result.data);
      return;
    }
    // `invalid_options` names the options in `issues` ("sides: must be at
    // least 2"); the English detail stays out, the field gets the error.
    const refused = Array.isArray(result.body.issues)
      ? command.options
          .map((o) => o.name)
          .filter((name) => (result.body.issues as unknown[]).some((issue) => typeof issue === 'string' && issue.startsWith(`${name}:`)))
      : [];
    if (refused.length > 0) {
      setErrors(Object.fromEntries(refused.map((name) => [name, t('interactions.form.error.server')])));
      focusFirstInvalid(refused);
      return;
    }
    // EMAIL.md §4.2: running a command counts as posting. Said in words; the
    // composer locks once the shared status flips.
    if (handleEmailUnverified(result.status, result.body)) {
      setServerError(t(RESTRICTED_ACTION_KEYS.message));
      return;
    }
    // The command or its bot changed under us: the next `/` asks again.
    if (result.code && STALE_LIST_CODES.has(result.code)) invalidateChannelCommands(serverId, channelId);
    setServerError(
      result.code === 'blocked_by_moderation'
        ? t(moderationBlockedMessageKey(result.body.rule))
        : t(invokeErrorKey(result))
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onCancel();
    }
  }

  const textChannels = channels.filter((c) => c.category === 'text');
  const voiceChannels = channels.filter((c) => c.category === 'voice');

  function control(option: CommandOption, id: string, describedBy: string | undefined): ReactNode {
    const invalid = Boolean(errors[option.name]);
    const raw = values[option.name];
    const common = {
      id,
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
      'aria-required': option.required || undefined,
    };
    if (option.type === 'boolean') {
      const checked = raw === true;
      return (
        <button
          {...common}
          ref={register(option.name)}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={`${id}-label`}
          onClick={() => setValue(option.name, !checked)}
          className={`relative h-6 w-11 flex-none rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
            checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-container-high'
          }`}
        >
          <span
            className={`absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-all ${
              checked ? 'right-1 bg-on-primary' : 'left-1 bg-text-muted'
            }`}
          />
        </button>
      );
    }
    if (option.choices && (option.type === 'string' || option.type === 'integer' || option.type === 'number')) {
      return (
        <select
          {...common}
          ref={register(option.name)}
          value={typeof raw === 'string' ? raw : ''}
          onChange={(event) => setValue(option.name, event.target.value || undefined)}
          className={fieldClass(invalid)}
        >
          <option value="">{t('interactions.form.choose')}</option>
          {option.choices.map((choice) => (
            <option key={String(choice.value)} value={String(choice.value)}>
              {choice.name}
            </option>
          ))}
        </select>
      );
    }
    if (option.type === 'integer' || option.type === 'number') {
      return (
        <input
          {...common}
          ref={register(option.name)}
          type="number"
          inputMode={option.type === 'integer' ? 'numeric' : 'decimal'}
          step={option.type === 'integer' ? 1 : 'any'}
          min={option.min}
          max={option.max}
          value={typeof raw === 'string' ? raw : ''}
          onChange={(event) => setValue(option.name, event.target.value)}
          className={fieldClass(invalid)}
        />
      );
    }
    if (option.type === 'user') {
      return (
        <SearchSelect
          id={id}
          inputRef={register(option.name)}
          items={members.map((m) => ({ id: m.userId, label: m.displayName, sublabel: m.roleName, avatarUrl: m.avatarUrl, color: m.roleColor }))}
          value={typeof raw === 'string' ? raw : undefined}
          onChange={(value) => setValue(option.name, value)}
          placeholder={t('interactions.form.userPlaceholder')}
          noResults={t('interactions.form.noMembers')}
          invalid={invalid}
          describedBy={describedBy}
        />
      );
    }
    if (option.type === 'channel') {
      return (
        <select
          {...common}
          ref={register(option.name)}
          value={typeof raw === 'string' ? raw : ''}
          onChange={(event) => setValue(option.name, event.target.value || undefined)}
          className={fieldClass(invalid)}
        >
          <option value="">{t('interactions.form.chooseChannel')}</option>
          {textChannels.length > 0 ? (
            <optgroup label={t('interactions.form.textChannels')}>
              {textChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {voiceChannels.length > 0 ? (
            <optgroup label={t('interactions.form.voiceChannels')}>
              {voiceChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      );
    }
    return (
      <input
        {...common}
        ref={register(option.name)}
        type="text"
        maxLength={STRING_OPTION_MAX_LENGTH}
        value={typeof raw === 'string' ? raw : ''}
        onChange={(event) => setValue(option.name, event.target.value)}
        className={fieldClass(invalid)}
      />
    );
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-labelledby={titleId}
      data-slash-form
      noValidate
      className="z-10 bg-background px-4 pb-6 pt-2 sm:px-6"
    >
      <div className="rounded-lg border border-primary/60 bg-surface-container-low shadow-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle px-3 py-2">
          <h2 id={titleId} className="font-mono text-sm font-semibold text-primary">
            /{command.name}
          </h2>
          {command.description ? (
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{command.description}</span>
          ) : (
            <span className="flex-1" />
          )}
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <span className="max-w-[10rem] truncate">{command.bot.name || t('lobbyMain.chat.unknownBot')}</span>
            <BotBadge />
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('interactions.form.cancelLabel', { command: command.name })}
            className="grid size-7 place-items-center rounded-md text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden>close</span>
          </button>
        </div>

        {command.options.length > 0 ? (
          <div className="grid gap-3 p-3 sm:grid-cols-2">
            {command.options.map((option) => {
              const id = `${baseId}-${option.name}`;
              const hint = option.description || rangeHint(t, option);
              const hintId = hint ? `${id}-hint` : undefined;
              const errorId = errors[option.name] ? `${id}-error` : undefined;
              const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
              const isSwitch = option.type === 'boolean';
              return (
                <div key={option.name} data-option={option.name} className={isSwitch ? 'flex flex-col gap-1' : 'block'}>
                  <div className={isSwitch ? 'flex items-center justify-between gap-3' : ''}>
                    <label
                      id={`${id}-label`}
                      htmlFor={id}
                      className={`${isSwitch ? '' : 'mb-1 '}block font-mono text-xs font-medium text-text-secondary`}
                    >
                      {option.name}
                      {option.required ? (
                        <>
                          <span aria-hidden className="ml-0.5 text-danger">*</span>
                          <span className="sr-only"> {t('interactions.form.required')}</span>
                        </>
                      ) : null}
                    </label>
                    {isSwitch ? control(option, id, describedBy) : null}
                  </div>
                  {isSwitch ? null : control(option, id, describedBy)}
                  {hint ? (
                    <p id={hintId} className="mt-1 text-[11px] text-text-muted">
                      {option.description && rangeHint(t, option) ? `${option.description} · ${rangeHint(t, option)}` : hint}
                    </p>
                  ) : null}
                  {errors[option.name] ? (
                    <p id={errorId} className="mt-1 text-xs text-danger">
                      {errors[option.name]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-3 py-3 text-sm text-text-secondary">{t('interactions.form.noOptions')}</p>
        )}

        {serverError ? (
          <p role="alert" className="mx-3 mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {serverError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-3 py-2">
          <span className="hidden text-[11px] text-text-muted sm:inline">{t('interactions.form.keys')}</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              {t('common.cancel')}
            </button>
            <button
              ref={runButton}
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? t('interactions.form.running') : t('interactions.form.run', { command: command.name })}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
