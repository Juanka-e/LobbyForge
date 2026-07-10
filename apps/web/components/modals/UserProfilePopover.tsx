'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface UserProfilePopoverProps {
  open: boolean;
  onClose: () => void;
  user: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    isGuest: boolean;
    roleName?: string | null;
    roleColor?: string | null;
    statusText?: string | null;
    onlineStatus?: 'online' | 'in_voice' | 'idle' | 'offline';
  } | null;
  anchorRect?: DOMRect | null;
  getVolume?: (userId: string) => number;
  onVolumeChange?: (userId: string, volume: number) => void;
  isBlocked?: boolean;
  onToggleBlock?: (userId: string) => void;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  online: { label: 'Online', color: 'text-success', dot: 'bg-success' },
  in_voice: { label: 'In Voice', color: 'text-success', dot: 'bg-success' },
  idle: { label: 'Idle', color: 'text-tertiary', dot: 'bg-tertiary' },
  offline: { label: 'Offline', color: 'text-text-muted', dot: 'bg-text-muted' },
};

export function UserProfilePopover({
  open,
  onClose,
  user,
  anchorRect,
  getVolume,
  onVolumeChange,
  isBlocked,
  onToggleBlock,
}: UserProfilePopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [volume, setVolume] = useState<number>(1);

  useLayoutEffect(() => {
    if (!open || !user || !anchorRect) {
      setPosition(null);
      return;
    }
    const pw = 340;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchorRect.right + margin;
    if (left + pw > vw - 8) left = anchorRect.left - pw - margin;
    if (left < 8) left = 8;
    const top = Math.max(8, Math.min(anchorRect.top - 8, vh - 420));
    setPosition({ left, top });
  }, [open, user, anchorRect]);

  useEffect(() => {
    if (open && user && getVolume) setVolume(getVolume(user.userId));
  }, [open, user, getVolume]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        const t = e.target as HTMLElement | null;
        if (t?.closest('[data-user-popover-anchor]')) return;
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !user || typeof document === 'undefined') return null;

  const status = user.onlineStatus ? STATUS_CONFIG[user.onlineStatus] ?? STATUS_CONFIG.offline : null;
  const showVolume = user.onlineStatus === 'in_voice' && !!getVolume && !!onVolumeChange;
  const roleColor = user.roleColor || undefined;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${user.displayName} profile`}
      className="fixed z-50 w-[340px] rounded-2xl overflow-hidden border border-border-subtle bg-surface-floating shadow-2xl"
      style={position ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
    >
      {/* Banner */}
      <div
        className="h-28 relative"
        style={{
          background: roleColor
            ? `linear-gradient(135deg, ${roleColor}, ${roleColor}40)`
            : 'linear-gradient(135deg, #1e293b, #0f172a)',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/50 transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="px-5 pb-5 -mt-14">
        {/* Avatar */}
        <div className="flex items-end justify-between mb-3">
          <div
            className="w-[80px] h-[80px] rounded-full overflow-hidden border-4 border-surface-floating bg-surface-container flex items-center justify-center"
            style={roleColor ? { boxShadow: `0 0 0 3px ${roleColor}` } : undefined}
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-3xl font-bold text-text-primary">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
        </div>

        {/* Name + badges */}
        <div className="mb-4">
          <h4 className="text-xl font-bold leading-tight" style={{ color: roleColor ?? '#F4F7FB' }}>
            {user.displayName}
          </h4>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {user.isGuest ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-container text-text-muted font-bold uppercase tracking-wide">Guest</span>
            ) : null}
            {user.roleName ? (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide"
                style={roleColor ? { backgroundColor: `${roleColor}25`, color: roleColor } : { backgroundColor: '#263142', color: '#B7C0CC' }}
              >
                {user.roleName}
              </span>
            ) : null}
            {status ? (
              <span className="flex items-center gap-1 text-xs">
                <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                <span className={status.color}>{status.label}</span>
              </span>
            ) : null}
          </div>
        </div>

        {/* Bio / status text */}
        <div className="mb-4 pb-4 border-b border-border-subtle">
          <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1 font-bold">About</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            {user.statusText || 'No bio set. This user hasn\'t added a custom status yet.'}
          </p>
        </div>

        {/* Volume slider */}
        {showVolume ? (
          <div className="mb-4 pb-4 border-b border-border-subtle">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[18px] text-text-secondary">
                  {volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}
                </span>
                <span className="text-xs text-text-secondary font-bold uppercase tracking-wide">Volume</span>
              </div>
              <span className={`text-xs font-mono ${volume === 0 ? 'text-danger' : 'text-text-primary'}`}>
                {Math.round(volume * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                onVolumeChange!(user.userId, v);
              }}
              className="w-full accent-primary h-1.5 cursor-pointer"
              aria-label={`Volume for ${user.displayName}`}
            />
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex gap-2">
          {onToggleBlock ? (
            <button
              type="button"
              onClick={() => onToggleBlock(user.userId)}
              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${
                isBlocked
                  ? 'border-border-subtle text-text-secondary hover:bg-surface-container hover:text-text-primary'
                  : 'border-danger/30 text-danger hover:bg-danger/10'
              }`}
            >
              {isBlocked ? 'Unblock' : 'Block user'}
            </button>
          ) : null}
          <a
            href={`/settings/voice-video`}
            className="flex-1 py-2 rounded-lg text-xs font-bold border border-border-subtle text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors text-center"
          >
            Voice settings
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}
