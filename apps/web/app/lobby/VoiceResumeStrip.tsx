'use client';

import { useT } from '@/lib/i18n/client';
import { useLobbyVoice } from './LobbyVoiceProvider';

/**
 * "You dropped out of voice. [Back to #channel]" — after a reload, or when
 * LiveKit gave up reconnecting (docs/ACTIVITY_INTEGRITY_AND_RESILIENCE.md
 * §3.2; the provider decides when there is a way back). One click goes
 * back, and that click is also the gesture browsers want before they play
 * audio. Dismissing it forgets the way back.
 *
 * - `lobby`: across the top of the centre column, above whatever it shows.
 *   On a phone the voice footer sits in the closed drawer, so this is where
 *   a player in a game learns they dropped. It steps aside while the
 *   activities view of that same channel is open: that view shows its own.
 * - `activity`: inside the activities view (it renders the strip only for
 *   its own channel).
 *
 * A polite status, not an alert: nothing is lost by reading it later.
 */
export function VoiceResumeStrip({ placement }: { placement: 'lobby' | 'activity' }) {
  const t = useT();
  const voice = useLobbyVoice();
  const offer = voice.voiceResume;
  if (!offer || !voice.resumeVoice) return null;
  if (
    placement === 'lobby' &&
    voice.mainViewMode === 'activity' &&
    voice.activeActivityChannel?.channelId === offer.channelId
  ) {
    return null;
  }
  const resume = voice.resumeVoice;
  const dismiss = voice.dismissVoiceResume;

  return (
    <div
      role="status"
      data-testid="voice-resume-strip"
      data-placement={placement}
      className={
        placement === 'lobby'
          ? // The mobile menu button is fixed over the top-left corner below md.
            'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-ember/40 bg-ember/10 py-2.5 pl-16 pr-4 sm:pr-6 md:pl-6'
          : 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ember/40 bg-ember/10 px-6 py-2.5'
      }
    >
      <span className="material-symbols-outlined text-[20px] text-ember" aria-hidden>
        headset_off
      </span>
      {/* A floor for the message: on a phone the button wraps onto its own
          line instead of squeezing the sentence to one word per line. */}
      <div data-testid="voice-resume-message" className="min-w-[10rem] flex-1">
        <p className="text-sm font-medium text-text-primary">{t('lobby.voice.resume.message')}</p>
        {/* Why, when LiveKit said (a server restart) or the way back failed. */}
        {voice.error ? <p className="mt-0.5 text-pretty text-xs text-text-secondary">{voice.error}</p> : null}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void resume()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary-container px-3 py-1.5 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden>
            headset_mic
          </span>
          {offer.channelName
            ? t('lobby.voice.resume.action', { channel: offer.channelName })
            : t('lobby.voice.resume.actionUnnamed')}
        </button>
        {dismiss ? (
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('lobby.voice.resume.dismiss')}
            title={t('lobby.voice.resume.dismiss')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden>
              close
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
