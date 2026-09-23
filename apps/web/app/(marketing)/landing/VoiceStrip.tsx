import { getTranslator } from '@/lib/i18n/server';

/**
 * The hub's signature element: a voice room reduced to its signal.
 *
 * Speakers render as clusters of vertical bars (like the speaking
 * indicators around a LobbyForge voice room). Exactly one speaker is
 * ON AIR — drawn in ember, the live-activities accent — the way a
 * recording lamp marks whoever holds the room. Everyone else is a cool
 * idle blue. Pure CSS motion; under prefers-reduced-motion the bars
 * settle into varied static heights (see .lf-voice-bar in globals.css).
 *
 * Server component — no client JS ships for this visual.
 */

const SPEAKERS: { id: string; name: string; onAir: boolean; bars: number[] }[] = [
  { id: 'nova', name: 'Nova', onAir: false, bars: [10, 18, 8, 14, 6] },
  { id: 'kaya', name: 'Kaya', onAir: true, bars: [22, 34, 16, 40, 26] },
  { id: 'mira', name: 'Mira', onAir: false, bars: [8, 12, 6, 16, 10] },
  { id: 'theo', name: 'Theo', onAir: false, bars: [12, 6, 18, 8, 14] },
  { id: 'juno', name: 'Juno', onAir: false, bars: [6, 14, 10, 8, 18] },
  { id: 'ember', name: 'Ember', onAir: false, bars: [14, 8, 20, 10, 6] },
];

export default async function VoiceStrip() {
  const t = await getTranslator();
  const onAirName = SPEAKERS.find((s) => s.onAir)?.name ?? '';
  const listening = SPEAKERS.length - 1;
  return (
    <figure
      aria-label={t('hub.landing.strip.label', { speaker: onAirName, count: listening })}
      className="w-full rounded-2xl border border-border-subtle/40 bg-surface/70 backdrop-blur-sm overflow-hidden shadow-mockup"
    >
      {/* Room header — the vocabulary of the product itself */}
      <figcaption className="flex items-center justify-between gap-4 px-5 py-3 border-b border-border-subtle/30 bg-surface-raised/60">
        <span className="flex items-center gap-2 font-label-sm text-label-sm text-text-secondary">
          <span className="material-symbols-outlined text-base" aria-hidden>
            volume_up
          </span>
          {t('hub.landing.mockup.mainLounge')}
        </span>
        <span className="flex items-center gap-2 font-label-xs text-label-xs">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-ember opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full size-2 bg-ember" />
          </span>
          <span className="text-ember font-semibold tracking-widest uppercase">
            {t('hub.landing.strip.onAir')}
          </span>
          <span className="text-text-muted">
            {t('hub.landing.strip.counts', { talking: 1, listening })}
          </span>
        </span>
      </figcaption>

      {/* The strip: speakers as bar clusters, heights encode state */}
      <div className="flex items-end justify-between gap-2 sm:gap-6 px-5 sm:px-10 py-10 min-h-[168px]">
        {SPEAKERS.map((speaker) => (
          <div key={speaker.id} className="flex flex-col items-center gap-3 flex-1 min-w-0">
            <div className="flex items-end gap-[3px] h-16" aria-hidden>
              {speaker.bars.map((height, i) => (
                <span
                  key={i}
                  className={`lf-voice-bar w-[5px] rounded-full ${
                    speaker.onAir ? 'bg-ember' : 'bg-primary/40'
                  }`}
                  style={{
                    height: `${height * 1.6}px`,
                    animationDelay: `${(i * 0.18 + speaker.id.length * 0.07).toFixed(2)}s`,
                    animationDuration: speaker.onAir ? '0.9s' : '2.2s',
                  }}
                />
              ))}
            </div>
            <span
              className={`font-label-xs text-label-xs truncate max-w-full ${
                speaker.onAir ? 'text-ember' : 'text-text-muted'
              }`}
            >
              {speaker.name}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}
