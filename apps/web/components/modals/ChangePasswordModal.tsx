'use client';

import { useMemo, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
  /** Persist new password. Throwing surfaces the error inline. */
  onSave: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
}

interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  tone: 'danger' | 'warning' | 'success';
  rules: { ok: boolean; label: string }[];
}

function evaluateStrength(value: string, current: string): Strength {
  const lengthOk = value.length >= 8;
  const numberOk = /\d/.test(value);
  const specialOk = /[^A-Za-z0-9]/.test(value);
  const mismatchOk = value.length > 0 && value !== current;
  const rules = [
    { ok: lengthOk, label: 'At least 8 characters' },
    { ok: numberOk, label: 'Contains a number' },
    { ok: specialOk, label: 'Contains a special character' },
    { ok: mismatchOk, label: 'Does not match current password' },
  ];
  const score = (rules.filter((rule) => rule.ok).length as 0 | 1 | 2 | 3 | 4);
  if (value.length === 0) {
    return { score: 0, label: 'Enter a new password', tone: 'danger', rules };
  }
  if (score <= 1) return { score, label: 'Too weak', tone: 'danger', rules };
  if (score === 2) return { score, label: 'Could be stronger', tone: 'warning', rules };
  if (score === 3) return { score, label: 'Strong password', tone: 'success', rules };
  return { score, label: 'Excellent password', tone: 'success', rules };
}

export function ChangePasswordModal({ open, onClose, onSave }: ChangePasswordModalProps) {
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
    newPassword.length >= 8 &&
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
      title="Change Password"
      description="Update the password for your local account."
      size="md"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!canSave} loading={saving}>
            Update Password
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="space-y-5">
        <PasswordField
          label="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          visible={showCurrent}
          onToggleVisible={() => setShowCurrent((value) => !value)}
          placeholder="Enter current password"
        />
        <div>
          <PasswordField
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            visible={showNew}
            onToggleVisible={() => setShowNew((value) => !value)}
            placeholder="Enter new password"
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
                  {strength.label}
                </span>
              </div>
              <ul className="space-y-1.5 text-xs text-text-muted">
                {strength.rules.map((rule) => (
                  <li key={rule.label} className="flex items-center">
                    <span
                      className={`material-symbols-outlined text-[14px] mr-1.5 ${
                        rule.ok ? 'text-success' : 'text-text-muted'
                      }`}
                    >
                      {rule.ok ? 'check_circle' : 'circle'}
                    </span>
                    {rule.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <PasswordField
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          visible={showConfirm}
          onToggleVisible={() => setShowConfirm((value) => !value)}
          placeholder="Re-enter new password"
          invalid={confirm.length > 0 && confirm !== newPassword}
        />
        <div className="flex items-start bg-surface-container-low p-3 rounded-lg border border-border-subtle">
          <span className="material-symbols-outlined text-primary text-[18px] mr-2 mt-0.5">
            info
          </span>
          <p className="text-xs text-text-secondary leading-relaxed">
            Changing your password keeps this device signed in, but other sessions will need to sign in again.
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
        />
        <button
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? 'Hide password' : 'Show password'}
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
