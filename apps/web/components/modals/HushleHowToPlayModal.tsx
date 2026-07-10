'use client';

import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

export interface HushleHowToPlayModalProps {
  open: boolean;
  onClose: () => void;
  onStart: () => void | Promise<void>;
  metadata?: {
    players: string;
    duration: string;
  };
}

const DEFAULT_METADATA = {
  players: '3–12 players',
  duration: '10–30 min',
};

const STEPS: { title: string; description: string }[] = [
  {
    title: 'Join a voice room',
    description: 'Players join the same voice room before the activity begins.',
  },
  {
    title: 'Describe the word',
    description: 'One player describes the secret word without using the forbidden clues.',
  },
  {
    title: 'Guess before time runs out',
    description: 'Teammates score by finding the word before the timer ends.',
  },
];

export function HushleHowToPlayModal({
  open,
  onClose,
  onStart,
  metadata = DEFAULT_METADATA,
}: HushleHowToPlayModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <ModalCancelButton onClick={onClose}>Close</ModalCancelButton>
          <ModalPrimaryButton onClick={onStart} icon="play_arrow">
            Start in Voice Room
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <header className="flex items-start gap-4">
          <div className="w-16 h-16 bg-[#FFE5B4] rounded-xl flex items-center justify-center shadow-lg shadow-black/20 flex-shrink-0">
            <span className="material-symbols-outlined text-4xl text-[#8B5E3C]" style={{ fontVariationSettings: '"FILL" 1' }}>
              theater_comedy
            </span>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-text-primary mb-1">Hushle</h2>
            <span className="text-xs text-text-secondary bg-surface px-2 py-1 rounded border border-border-subtle">
              Party Game
            </span>
          </div>
        </header>

        <p className="text-[15px] text-text-secondary">
          Describe the secret word without using any of the forbidden clues.
        </p>

        <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
          <MetadataChip icon="groups" label={metadata.players} />
          <MetadataChip icon="timer" label={metadata.duration} />
          <MetadataChip icon="mic" label="Voice required" />
          <MetadataChip icon="check_circle" label="Community installed" tone="primary" />
        </div>

        <div>
          <h3 className="text-base font-semibold text-text-primary mb-3">How to Play</h3>
          <div className="space-y-4">
            {STEPS.map((step, index) => (
              <div key={step.title} className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface border border-border-subtle flex items-center justify-center text-sm font-medium text-primary">
                  {index + 1}
                </div>
                <div>
                  <h4 className="text-sm font-medium text-text-primary mb-1">{step.title}</h4>
                  <p className="text-sm text-text-secondary">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface p-4 rounded-xl border border-border-subtle flex flex-col gap-3">
          <div className="flex gap-3 text-text-secondary text-sm items-start">
            <span className="material-symbols-outlined text-primary mt-0.5 text-[18px]">info</span>
            <p>
              LobbyForge keeps your voice connection active while Hushle opens its own game interface.
            </p>
          </div>
          <div className="border-t border-border-subtle/50 pt-3 flex items-center gap-2 text-xs">
            <span className="text-text-muted">Can start:</span>
            <span className="text-text-primary font-medium">Members with the Start Activities permission</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function MetadataChip({
  icon,
  label,
  tone = 'default',
}: {
  icon: string;
  label: string;
  tone?: 'default' | 'primary';
}) {
  return (
    <div className="flex items-center gap-1.5 bg-surface px-2.5 py-1.5 rounded border border-border-subtle">
      <span className={`material-symbols-outlined text-[16px] ${tone === 'primary' ? 'text-primary' : ''}`}>
        {icon}
      </span>
      <span>{label}</span>
    </div>
  );
}
