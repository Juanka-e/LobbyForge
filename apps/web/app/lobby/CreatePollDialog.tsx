'use client';

import { useId, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '@/components/Modal';
import { useT } from '@/lib/i18n/client';
import { moderationBlockedMessageKey } from '@/lib/bots/catalog';
import { handleEmailUnverified } from '@/components/email-verification/EmailUnverifiedNotice';
import {
  CHAT_POLL_DEFAULT_DURATION_HOURS,
  CHAT_POLL_DURATIONS_HOURS,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_POLL_MIN_OPTIONS,
  CHAT_POLL_OPTION_MAX,
  CHAT_POLL_QUESTION_MAX,
  asChatPollView,
  checkChatPollDraft,
  type ChatPollDurationHours,
  type ChatPollView,
} from '@/lib/chat-polls';

/**
 * "Create poll" from the composer's menu (docs/CHAT_POLLS.md): a question,
 * 2–10 answers, "allow multiple answers" and how long it stays open. The
 * draft is checked with the route's own rules before it is sent; the
 * server's refusals (moderation, timeout, permission) come back in words.
 */

export interface CreatedPoll {
  message: { id: string; content: string; userId: string | null; createdAt: string };
  poll: ChatPollView;
}

export interface CreatePollDialogProps {
  open: boolean;
  onClose: () => void;
  serverId: string;
  channelId: string;
  channelName: string;
  onCreated: (created: CreatedPoll) => void;
}

const durationLabelArgs = (hours: ChatPollDurationHours) =>
  hours % 24 === 0 && hours >= 72
    ? { key: 'lobbyMain.poll.durationDays', count: hours / 24 }
    : { key: 'lobbyMain.poll.durationHours', count: hours };

export function CreatePollDialog({ open, onClose, serverId, channelId, channelName, onCreated }: CreatePollDialogProps) {
  const t = useT();
  const baseId = useId();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [duration, setDuration] = useState<ChatPollDurationHours>(CHAT_POLL_DEFAULT_DURATION_HOURS);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const check = checkChatPollDraft(question, options);

  function reset() {
    setQuestion('');
    setOptions(['', '']);
    setAllowMultiple(false);
    setDuration(CHAT_POLL_DEFAULT_DURATION_HOURS);
    setAttempted(false);
    setServerError(null);
  }

  function close() {
    if (sending) return;
    reset();
    onClose();
  }

  async function submit() {
    setAttempted(true);
    setServerError(null);
    if (!check.ok || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/polls`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: check.question, options: check.options, allowMultiple, durationHours: duration }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        rule?: string;
        message?: CreatedPoll['message'];
        poll?: unknown;
      };
      if (handleEmailUnverified(res.status, body)) {
        reset();
        onClose();
        return;
      }
      if (!res.ok) {
        if (body.code === 'blocked_by_moderation') setServerError(t(moderationBlockedMessageKey(body.rule)));
        else if (body.code === 'poll_duplicate_option') setServerError(t('lobbyMain.poll.optionDuplicate'));
        else if (res.status === 403) setServerError(t('lobbyMain.poll.forbidden'));
        else setServerError(t('lobbyMain.poll.failed', { status: res.status }));
        return;
      }
      const poll = asChatPollView(body.poll);
      if (body.message && poll) onCreated({ message: body.message, poll });
      reset();
      onClose();
    } catch {
      setServerError(t('lobbyMain.poll.failed', { status: 0 }));
    } finally {
      setSending(false);
    }
  }

  const questionId = `${baseId}-question`;
  const questionErrorId = `${baseId}-question-error`;
  const optionsErrorId = `${baseId}-options-error`;
  const questionError =
    attempted && check.questionProblem === 'required'
      ? t('lobbyMain.poll.questionRequired')
      : check.questionProblem === 'tooLong'
        ? t('lobbyMain.poll.questionTooLong', { max: CHAT_POLL_QUESTION_MAX })
        : null;
  const optionsError = attempted && check.optionsProblem === 'tooFew' ? t('lobbyMain.poll.optionsTooFew', { min: CHAT_POLL_MIN_OPTIONS }) : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('lobbyMain.poll.dialogTitle')}
      description={t('lobbyMain.poll.dialogDescription', { channel: channelName })}
      size="lg"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={sending} />
          <ModalPrimaryButton onClick={() => void submit()} loading={sending}>
            {t('lobbyMain.poll.post')}
          </ModalPrimaryButton>
        </>
      }
    >
      <form
        data-create-poll
        className="space-y-5 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <div>
          <label htmlFor={questionId} className="mb-1 block text-sm font-medium text-text-primary">
            {t('lobbyMain.poll.questionLabel')}
          </label>
          <textarea
            id={questionId}
            value={question}
            rows={2}
            maxLength={CHAT_POLL_QUESTION_MAX + 50}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('lobbyMain.poll.questionPlaceholder')}
            aria-invalid={questionError ? true : undefined}
            aria-describedby={questionError ? questionErrorId : `${questionId}-count`}
            className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
          />
          <div className="mt-1 flex justify-between gap-2 text-xs">
            <span id={questionErrorId} className="text-danger" role={questionError ? 'alert' : undefined}>
              {questionError}
            </span>
            <span id={`${questionId}-count`} className="shrink-0 text-text-muted">
              {t('lobbyMain.poll.remaining', { count: Math.max(0, CHAT_POLL_QUESTION_MAX - question.trim().length) })}
            </span>
          </div>
        </div>

        <fieldset aria-describedby={optionsError ? optionsErrorId : undefined}>
          <legend className="mb-1 text-sm font-medium text-text-primary">{t('lobbyMain.poll.optionsLabel')}</legend>
          <p className="mb-2 text-xs text-text-muted">
            {t('lobbyMain.poll.optionLimit', { min: CHAT_POLL_MIN_OPTIONS, max: CHAT_POLL_MAX_OPTIONS })}
          </p>
          <div className="space-y-2">
            {options.map((value, index) => {
              const problem = check.optionProblems[index];
              const inputId = `${baseId}-option-${index}`;
              const errorId = `${inputId}-error`;
              const message =
                problem === 'duplicate'
                  ? t('lobbyMain.poll.optionDuplicate')
                  : problem === 'tooLong'
                    ? t('lobbyMain.poll.optionTooLong', { max: CHAT_POLL_OPTION_MAX })
                    : null;
              return (
                <div key={index}>
                  <div className="flex items-center gap-2">
                    <label htmlFor={inputId} className="sr-only">
                      {t('lobbyMain.poll.optionLabel', { index: index + 1 })}
                    </label>
                    <input
                      id={inputId}
                      value={value}
                      maxLength={CHAT_POLL_OPTION_MAX + 20}
                      onChange={(event) => setOptions((current) => current.map((o, i) => (i === index ? event.target.value : o)))}
                      placeholder={t('lobbyMain.poll.optionPlaceholder', { index: index + 1 })}
                      aria-invalid={message ? true : undefined}
                      aria-describedby={message ? errorId : undefined}
                      data-poll-option-input={index}
                      className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
                    />
                    {options.length > CHAT_POLL_MIN_OPTIONS ? (
                      <button
                        type="button"
                        onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                        aria-label={t('lobbyMain.poll.removeOption', { index: index + 1 })}
                        title={t('lobbyMain.poll.removeOption', { index: index + 1 })}
                        className="grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-surface-container hover:text-danger"
                      >
                        <span className="material-symbols-outlined text-[18px]" aria-hidden>close</span>
                      </button>
                    ) : null}
                  </div>
                  {message ? (
                    <p id={errorId} className="mt-1 text-xs text-danger">
                      {message}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {options.length < CHAT_POLL_MAX_OPTIONS ? (
            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ''])}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden>add</span>
              {t('lobbyMain.poll.addOption')}
            </button>
          ) : null}
          {optionsError ? (
            <p id={optionsErrorId} role="alert" className="mt-1 text-xs text-danger">
              {optionsError}
            </p>
          ) : null}
        </fieldset>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={allowMultiple}
              onChange={(event) => setAllowMultiple(event.target.checked)}
              className="size-4 rounded border-border-strong bg-surface text-primary focus:ring-primary"
            />
            {t('lobbyMain.poll.allowMultiple')}
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-text-primary">
            {t('lobbyMain.poll.durationLabel')}
            <select
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value) as ChatPollDurationHours)}
              className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm font-normal text-text-primary outline-none focus:border-primary sm:w-40"
            >
              {CHAT_POLL_DURATIONS_HOURS.map((hours) => {
                const label = durationLabelArgs(hours);
                return (
                  <option key={hours} value={hours}>
                    {t(label.key, { count: label.count })}
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        <p className="text-xs text-text-muted">{t('lobbyMain.poll.anonymousNote')}</p>
        {serverError ? (
          <p role="alert" className="text-sm text-danger">
            {serverError}
          </p>
        ) : null}
        {/* Enter in a field submits the form; the visible button lives in the modal footer. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          {t('lobbyMain.poll.post')}
        </button>
      </form>
    </Modal>
  );
}
