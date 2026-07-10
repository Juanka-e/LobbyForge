'use client';

type SettingsStickyFooterProps = {
  status: string;
  updatedAt?: string | null;
  dirty: boolean;
  busy?: boolean;
  saveLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
  resetLabel?: string;
  onSave: () => void;
  onReset?: () => void;
  saveDisabled?: boolean;
};

export default function SettingsStickyFooter({
  status,
  updatedAt,
  dirty,
  busy = false,
  saveLabel = 'Save changes',
  savedLabel = 'Saved',
  savingLabel = 'Saving...',
  resetLabel = 'Reset',
  onSave,
  onReset,
  saveDisabled,
}: SettingsStickyFooterProps) {
  const disabled = saveDisabled ?? (busy || !dirty);
  return (
    <footer className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface/95 p-3 shadow-xl shadow-black/30 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0 text-xs text-text-muted">
        {status}
        {updatedAt ? ` - updated ${new Date(updatedAt).toLocaleString()}` : ''}
      </span>
      <div className="flex shrink-0 justify-end gap-2">
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            disabled={busy || !dirty}
            className="btn-secondary-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {resetLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSave}
          disabled={disabled}
          className="btn-primary-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? savingLabel : dirty ? saveLabel : savedLabel}
        </button>
      </div>
    </footer>
  );
}
