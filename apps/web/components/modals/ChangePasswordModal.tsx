'use client';

import { useMemo, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';
import { useT } from '@/lib/i18n/client';

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
  /** Persist new password. Throwing surfaces the error inline. */
  onSave: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
}

/** Labels are message keys, resolved with `t()` where they render. */
interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  labelKey: string;
  tone: 'danger' | 'warning' | 'success';
  rules: { ok: boolean; labelKey: string }[];
}

function evaluateStrength(value: string, current: string): Strength {
  const lengthOk = value.length >= 12;
  const numberOk = /\d/.test(value);
  const specialOk = /[^A-Za-z0-9]/.test(value);
  const mismatchOk = value.length > 0 && value !== current;
  const rules = [
    { ok: lengthOk, labelKey: 'shell.password.rule.length' },
    { ok: numberOk, labelKey: 'shell.password.rule.number' },
    { ok: specialOk, labelKey: 'shell.password.rule.special' },
    { ok: mismatchOk, labelKey: 'shell.password.rule.differs' },
  ];
  const score = (rules.filter((rule) => rule.ok).length as 0 | 1 | 2 | 3 | 4);
  if (value.length === 0) {
    return { score: 0, labelKey: 'shell.password.strength.empty', tone: 'danger', rules };
  }
  if (score <= 1) return { score, labelKey: 'shell.password.strength.weak', tone: 'danger', rules };
  if (score === 2) return { score, labelKey: 'shell.password.strength.fair', tone: 'warning', rules };
  if (score === 3) return { score, labelKey: 'shell.password.strength.strong', tone: 'success', rules };
  return { score, labelKey: 'shell.password.strength.excellent', tone: 'success', rules };
}

export function ChangePasswordModal({ open, onClose, onSave }: ChangePasswordModalProps) {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = useMemo(
    () => evaluateStrength(newPassword, currentPassword),
    [newPassword, currentPassword]
  );

  const canSave =
    currentPassword.length > 0 &&
    newPassword.length >= 12 &&
    newPassword === confirm &&
    strength.score >= 3;

  function close() {
    if (saving) return;
    resetAndClose();
  }

  function resetAndClose() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    setError(null);
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
    onClose();
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ currentPassword, newPassword });
      resetAndClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('shell.password.title')}
      description={t('shell.password.description')}
      size="md"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!canSave} loading={saving}>
            {t('shell.password.submit')}
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="space-y-5">
        <PasswordField
          label={t('shell.password.current')}
          value={currentPassword}
          onChange={setCurrentPassword}
          visible={showCurrent}
          onToggleVisible={() => setShowCurrent((value) => !value)}
          placeholder={t('shell.password.currentPlaceholder')}
        />
        <div>
          <PasswordField
            label={t('shell.password.new')}
            value={newPassword}
            onChange={setNewPassword}
            visible={showNew}
            onToggleVisible={() => setShowNew((value) => !value)}
            placeholder={t('shell.password.newPlaceholder')}
          />
          {newPassword.length > 0 ? (
            <div className="mt-3 bg-surface p-3 rounded-lg border border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                {[0, 1, 2, 3].map((index) => {
                  const filled = strength.score > index;
                  const color =
                    strength.tone === 'success'
                      ? 'bg-success'
                      : strength.tone === 'warning'
                        ? 'bg-tertiary'
                        : 'bg-danger';
                  return (
                    <div
                      key={index}
                      className={`h-1 flex-1 rounded-full ${filled ? color : 'bg-surface-container'}`}
                    />
                  );
                })}
                <span
                  className={`text-xs ml-2 ${
                    strength.tone === 'success'
                      ? 'text-success'
                      : strength.tone === 'warning'
                        ? 'text-tertiary'
                        : 'text-danger'
                  }`}
                >
                  {t(strength.labelKey)}
                </span>
              </div>
              <ul className="space-y-1.5 text-xs text-text-muted">
                {strength.rules.map((rule) => (
                  <li key={rule.labelKey} className="flex items-center">
                    <span
                      className={`material-symbols-outlined text-[14px] mr-1.5 ${
                        rule.ok ? 'text-success' : 'text-text-muted'
                      }`}
                    >
                      {rule.ok ? 'check_circle' : 'circle'}
                    </span>
                    {t(rule.labelKey)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <PasswordField
          label={t('shell.password.confirm')}
          value={confirm}
          onChange={setConfirm}
          visible={showConfirm}
          onToggleVisible={() => setShowConfirm((value) => !value)}
          placeholder={t('shell.password.confirmPlaceholder')}
          invalid={confirm.length > 0 && confirm !== newPassword}
        />
        <div className="flex items-start bg-surface-container-low p-3 rounded-lg border border-border-subtle">
          <span className="material-symbols-outlined text-primary text-[18px] mr-2 mt-0.5">
            info
          </span>
          <p className="text-xs text-text-secondary leading-relaxed">
            {t('shell.password.sessionsNote')}
          </p>
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  onToggleVisible,
  placeholder,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  placeholder: string;
  invalid?: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <label className="text-sm text-text-secondary block">{label}</label>
      <div
        className={`flex items-center border rounded-lg px-3 py-2.5 transition-colors ${
          invalid ? 'border-danger' : 'border-border-strong bg-surface-container focus-within:border-primary'
        }`}
      >
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent border-none text-text-primary focus:ring-0 p-0 placeholder-text-muted"
          autoComplete="off"
          maxLength={128}
        />
        <button
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? t('shell.password.hide') : t('shell.password.show')}
          className="text-text-muted hover:text-text-primary ml-2"
        >
          <span className="material-symbols-outlined text-[20px]">
            {visible ? 'visibility' : 'visibility_off'}
          </span>
        </button>
      </div>
    </div>
  );
}
