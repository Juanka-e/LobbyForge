'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

/**
 * Hushle Room Selection modal.
 *
 * Shown when a host starts Hushle and more than one voice channel is
 * available. The host picks the voice channel the session will be
 * bound to; the LobbyForge activity host binds the session to that
 * channel via POST /api/servers/{id}/channels/{channelId}/activities
 * on confirm.
 *
 * Pattern mirrors `HushleHowToPlayModal`: Calm Future tokens, Modal
 * shell, PrimaryButton with `play_arrow` icon. Single-select list of
 * voice channels with presence counts.
 *
 * Stitch reference: design_stitch/lobbyforge_hushle_room_selection_final_overlay
 * (folder currently empty — design intent inferred from the lobby
 * sidebar voice channel group + the HushleHowToPlay visual treatment).
 */

export interface HushleVoiceChannelOption {
  id: string;
  name: string;
  /** Number of users currently in the channel (from Redis presence). */
  participantCount: number;
  /** True if the channel has an active activity (cannot host Hushle there). */
  busy?: boolean;
}

export interface HushleRoomSelectionModalProps {
  open: boolean;
  onClose: () => void;
  /** Voice channels the host can pick from. */
  channels: HushleVoiceChannelOption[];
  /** Pre-selected channel id (e.g. the channel the host is currently in). */
  defaultChannelId?: string | null;
  onStart: (channelId: string) => void | Promise<void>;
  starting?: boolean;
}

export function HushleRoomSelectionModal({
  open,
  onClose,
  channels,
  defaultChannelId,
  onStart,
  starting = false,
}: HushleRoomSelectionModalProps) {
  const available = useMemo(() => channels.filter((c) => !c.busy), [channels]);
  const initialId =
    defaultChannelId && available.some((c) => c.id === defaultChannelId)
      ? defaultChannelId
      : available[0]?.id ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(initialId);

  // Re-seed selection whenever the open state or default changes — the
  // modal is reused across activity launches so we can't rely on mount.
  useEffect(() => {
    if (!open) return;
    setSelectedId(initialId);
  }, [open, initialId]);

  const canStart = !!selectedId && !starting;

  function close() {
    if (starting) return;
    onClose();
  }

  async function start() {
    if (!canStart || !selectedId) return;
    await onStart(selectedId);
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      title="Start Hushle"
      description="Pick the voice channel where the session will run."
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={starting} />
          <ModalPrimaryButton
            onClick={start}
            disabled={!canStart}
            loading={starting}
            icon="play_arrow"
          >
            Start Session
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {available.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-surface-variant flex items-center justify-center">
              <span className="material-symbols-outlined text-text-muted">volume_off</span>
            </div>
            <p className="text-sm text-text-secondary">
              All voice channels are busy with another activity. End an existing
              session first.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {available.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  aria-pressed={c.id === selectedId}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                    c.id === selectedId
                      ? 'bg-primary/5 border-primary/40'
                      : 'border-border-subtle hover:bg-surface-container/50'
                  }`}
                >
                  <span
                    className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                      c.id === selectedId
                        ? 'bg-primary/15 text-primary'
                        : 'bg-surface-variant text-text-secondary'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[20px]">volume_up</span>
                  </span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-label-sm font-medium text-text-primary truncate">
                      {c.name}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {c.participantCount === 0
                        ? 'Empty'
                        : `${c.participantCount} in room`}
                    </span>
                  </div>
                  <span
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      c.id === selectedId ? 'border-primary' : 'border-border-subtle'
                    }`}
                  >
                    {c.id === selectedId ? (
                      <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {channels.some((c) => c.busy) ? (
          <p className="text-[11px] text-text-muted pt-2 border-t border-border-subtle">
            One activity per voice channel — busy rooms are hidden from this list.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
