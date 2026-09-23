'use client';

import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';
import { useT } from '@/lib/i18n/client';

export interface HushleHowToPlayModalProps {
  open: boolean;
  onClose: () => void;
  onStart: () => void | Promise<void>;
  metadata?: {
    players: string;
    duration: string;
  };
}

/** Hushle's usual table, used when the caller passes no metadata. */
const DEFAULT_PLAYERS = { min: 3, max: 12 };
const DEFAULT_MINUTES = { min: 10, max: 30 };

/** Message keys, resolved with `t()` where they render. */
const STEPS: { titleKey: string; descriptionKey: string }[] = [
  {
    titleKey: 'shell.howToPlay.steps.join.title',
    descriptionKey: 'shell.howToPlay.steps.join.description',
  },
  {
    titleKey: 'shell.howToPlay.steps.describe.title',
    descriptionKey: 'shell.howToPlay.steps.describe.description',
  },
  {
    titleKey: 'shell.howToPlay.steps.guess.title',
    descriptionKey: 'shell.howToPlay.steps.guess.description',
  },
];

export function HushleHowToPlayModal({
  open,
  onClose,
  onStart,
  metadata,
}: HushleHowToPlayModalProps) {
  const t = useT();
  const { players, duration } = metadata ?? {
    players: t('shell.howToPlay.players', DEFAULT_PLAYERS),
    duration: t('shell.howToPlay.duration', DEFAULT_MINUTES),
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.close')}</ModalCancelButton>
          <ModalPrimaryButton onClick={onStart} icon="play_arrow">
            {t('shell.howToPlay.start')}
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
              {t('shell.howToPlay.genre')}
            </span>
          </div>
        </header>

        <p className="text-[15px] text-text-secondary">
          {t('shell.howToPlay.summary')}
        </p>

        <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
          <MetadataChip icon="groups" label={players} />
          <MetadataChip icon="timer" label={duration} />
          <MetadataChip icon="mic" label={t('shell.howToPlay.voiceRequired')} />
          <MetadataChip icon="check_circle" label={t('shell.howToPlay.installed')} tone="primary" />
        </div>

        <div>
          <h3 className="text-base font-semibold text-text-primary mb-3">{t('shell.howToPlay.heading')}</h3>
          <div className="space-y-4">
            {STEPS.map((step, index) => (
              <div key={step.titleKey} className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface border border-border-subtle flex items-center justify-center text-sm font-medium text-primary">
                  {index + 1}
                </div>
                <div>
                  <h4 className="text-sm font-medium text-text-primary mb-1">{t(step.titleKey)}</h4>
                  <p className="text-sm text-text-secondary">{t(step.descriptionKey)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface p-4 rounded-xl border border-border-subtle flex flex-col gap-3">
          <div className="flex gap-3 text-text-secondary text-sm items-start">
            <span className="material-symbols-outlined text-primary mt-0.5 text-[18px]">info</span>
            <p>
              {t('shell.howToPlay.voiceStaysOn')}
            </p>
          </div>
          <div className="border-t border-border-subtle/50 pt-3 flex items-center gap-2 text-xs">
            <span className="text-text-muted">{t('shell.howToPlay.canStart')}</span>
            <span className="text-text-primary font-medium">{t('shell.howToPlay.canStartWho')}</span>
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
