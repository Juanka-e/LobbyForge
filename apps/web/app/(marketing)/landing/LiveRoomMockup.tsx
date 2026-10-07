import type { Translator } from '@/lib/i18n/core';
import { initialOf } from '@/lib/initial';
import { GamepadIcon, SpeakerIcon } from '../_components/icons';

/**
 * The hero's picture of a live voice room: who is in it, who is speaking
 * (on air, in ember), and the Hushle game running inside it. An
 * illustration, not a control — it is one image to assistive technology,
 * described by its label, and nothing in it is focusable.
 */

const SPEAKERS: Array<{ name: string; tint: string; speaking?: boolean }> = [
  { name: 'Kaya', tint: '#E7B86A', speaking: true },
  { name: 'Mira', tint: '#8FB8FF' },
  { name: 'Theo', tint: '#A8B3C5' },
  { name: 'Juno', tint: '#7CCFA6' },
  { name: 'Nova', tint: '#C9B6FF' },
  { name: 'Ember', tint: '#E98282' },
];

/** Initials sit on a pastel disc in every theme, so their ink is fixed. */
const INITIAL_INK = '#07101E';

export function VoiceBars({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden className={`flex h-3 items-end gap-[2px] ${className}`}>
      {[7, 12, 5, 10].map((height, index) => (
        <span
          key={index}
          className="lf-voice-bar w-[3px] rounded-full bg-ember"
          style={{ height, animationDelay: `${(index * 0.17).toFixed(2)}s`, animationDuration: '0.9s' }}
        />
      ))}
    </span>
  );
}

export default function LiveRoomMockup({ t }: { t: Translator }) {
  const speaker = SPEAKERS.find((s) => s.speaking)?.name ?? '';
  return (
    <div
      role="img"
      aria-label={t('hub.landing.room.label', { speaker })}
      className="flex flex-col overflow-hidden rounded-[24px] border border-border-subtle bg-background shadow-2xl sm:rounded-[28px] lg:h-[520px]"
    >
      <div className="flex h-12 items-center justify-between border-b border-border-subtle/70 px-4 sm:h-[52px] sm:px-5">
        <span className="flex items-center gap-2.5 text-sm font-semibold text-text-primary">
          <SpeakerIcon size={18} className="hidden text-text-secondary sm:block" />
          {t('hub.landing.room.name')}
        </span>
        <span className="flex h-6 items-center gap-2 rounded-full bg-ember/10 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ember sm:h-[26px] sm:text-xs">
          <span className="relative flex size-[7px]">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-ember opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-[7px] rounded-full bg-ember" />
          </span>
          {t('hub.landing.room.onAir')}
        </span>
      </div>

      <ul className="grid flex-1 grid-cols-3 gap-2.5 p-4 sm:gap-3.5 sm:p-[22px]">
        {SPEAKERS.map((person, index) => (
          <li
            key={person.name}
            className={`${index >= 3 ? 'hidden sm:flex' : 'flex'} h-24 flex-col items-center justify-center gap-2 rounded-2xl border bg-surface sm:h-auto sm:min-h-[132px] sm:gap-3 sm:rounded-[18px] lg:min-h-0 ${
              person.speaking ? 'border-ember/60' : 'border-border-subtle/70'
            }`}
          >
            <span
              className="flex size-10 items-center justify-center rounded-full text-base font-bold sm:size-14 sm:text-xl"
              style={{ backgroundColor: person.tint, color: INITIAL_INK }}
            >
              {initialOf(person.name, { locale: t.locale })}
            </span>
            <span className="flex items-center gap-1.5 text-[13px] text-text-primary sm:text-sm">
              {person.name}
              {person.speaking ? <VoiceBars /> : null}
            </span>
          </li>
        ))}
      </ul>

      <div className="mx-4 mb-4 flex items-center gap-3 rounded-[14px] border border-ember/35 bg-surface-raised px-3.5 py-3 sm:mx-[22px] sm:mb-[22px] sm:h-[76px] sm:gap-3.5 sm:rounded-[18px] sm:px-[18px] sm:py-0">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-ember/15 text-ember sm:flex">
          <GamepadIcon size={22} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold text-text-primary sm:text-[15px]">Hushle</span>
          <span className="truncate text-xs text-text-secondary sm:text-[13px]">{t('hub.landing.room.activityStatus')}</span>
        </span>
        <span className="flex h-10 shrink-0 items-center rounded-xl bg-ember px-3.5 text-sm font-semibold text-on-ember sm:px-[18px]">
          <span className="sm:hidden">{t('hub.landing.room.joinShort')}</span>
          <span className="hidden sm:inline">{t('hub.landing.room.join')}</span>
        </span>
      </div>
    </div>
  );
}
