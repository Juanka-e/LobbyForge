import { initialsFor } from '@/lib/hub-format';
import type { Translator } from '@/lib/i18n/core';
import tones from '../_components/hub-tones.module.css';

/**
 * "The whole community": a still of the app — server rail, channels with
 * a live Hushle, the chat, the member list with a bot and the Doctor.
 * Like the hero's room, it is one described image, not a working UI.
 *
 * The chat times are written the reader's way ("9:04 PM" / "21:04").
 */

const INITIAL_INK = '#07101E';

export default function CommunityPreview({ t }: { t: Translator }) {
  const clock = new Intl.DateTimeFormat(t.locale, { hour: 'numeric', minute: '2-digit' });
  const at = (minute: number) => clock.format(new Date(2026, 0, 1, 21, minute));
  const general = t('hub.landing.preview.channelGeneral');
  const serverName = t('hub.landing.preview.serverName');
  const messages = [
    { name: 'Kaya', tint: '#E7B86A', time: at(4), body: t('hub.landing.preview.message1'), bot: false },
    { name: 'Mira', tint: '#8FB8FF', time: at(5), body: t('hub.landing.preview.message2'), bot: false },
    { name: t('hub.landing.preview.welcomeBot'), tint: '#A8B3C5', time: at(6), body: t('hub.landing.preview.message3'), bot: true },
  ];
  const sectionLabel = 'px-2 text-[11px] uppercase tracking-[0.12em] text-text-muted';

  return (
    <div
      role="img"
      aria-label={t('hub.landing.preview.label')}
      className="grid h-[560px] overflow-hidden rounded-[30px] border border-border-subtle bg-background shadow-2xl md:grid-cols-[72px_220px_minmax(0,1fr)] xl:grid-cols-[72px_260px_minmax(0,1fr)_260px]"
    >
      {/* Server rail */}
      <div className="flex flex-col items-center gap-3 border-r border-border-subtle/70 bg-[color:var(--lf-page-bg)] pt-4">
        <span className="flex size-11 items-center justify-center rounded-[14px] bg-primary text-sm font-bold text-on-primary">LF</span>
        <span
          className="flex size-11 items-center justify-center rounded-full text-sm font-semibold"
          style={{ backgroundColor: '#8FB8FF', color: INITIAL_INK }}
        >
          {initialsFor(serverName, t.locale)}
        </span>
        <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-border-strong text-[22px] text-text-muted">
          +
        </span>
      </div>

      {/* Channels */}
      <div className="flex flex-col gap-1.5 border-r border-border-subtle/70 bg-surface px-3.5 py-[18px]">
        <span className="px-2 pb-3 text-[15px] font-semibold text-text-primary">{serverName}</span>
        <span className={`${sectionLabel} pb-1 pt-2`}>{t('hub.landing.preview.textChannels')}</span>
        <span className="rounded-[10px] bg-surface-raised p-2 text-sm text-text-primary"># {general}</span>
        <span className="p-2 text-sm text-text-secondary"># {t('hub.landing.preview.channelClips')}</span>
        <span className={`${sectionLabel} pb-1 pt-3.5`}>{t('hub.landing.preview.voiceChannels')}</span>
        <span className="p-2 text-sm text-text-secondary">{t('hub.landing.room.name')}</span>
        <span className="py-0.5 pl-6 pr-2 text-[13px] text-text-secondary">Kaya · Mira · Theo</span>
        <span className="mx-2 my-0.5 rounded-[10px] border border-ember/35 px-2.5 py-1.5 text-xs text-ember">
          {t('hub.landing.preview.hushlePlaying', { count: 4 })}
        </span>
        <span className="p-2 text-sm text-text-secondary">{t('hub.landing.preview.movieNight')}</span>
      </div>

      {/* Chat */}
      <div className="flex min-w-0 flex-col gap-[18px] px-[26px] py-5">
        <div className="flex items-center justify-between border-b border-border-subtle/70 pb-3.5">
          <span className="text-[15px] font-semibold text-text-primary"># {general}</span>
          <span className="flex h-8 items-center rounded-[10px] bg-ember/10 px-3 text-[13px] text-ember">
            {t('hub.landing.preview.activities')}
          </span>
        </div>
        {messages.map((message) => (
          <div key={message.time} className="flex gap-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold"
              style={{ backgroundColor: message.tint, color: INITIAL_INK }}
            >
              {Array.from(message.name)[0]}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                {message.name}
                {message.bot ? <BotBadge t={t} /> : null}
                <span className="text-xs font-normal text-text-muted">{message.time}</span>
              </span>
              <span className="text-sm leading-[1.5] text-text-secondary">{message.body}</span>
            </span>
          </div>
        ))}
        <div className="mt-auto flex h-12 items-center rounded-[14px] border border-border-subtle/70 bg-surface px-4 text-sm text-text-muted">
          {t('hub.landing.preview.composer', { channel: general })}
        </div>
      </div>

      {/* Members */}
      <div className="hidden flex-col gap-3 border-l border-border-subtle/70 bg-surface p-[18px] xl:flex">
        <span className="text-[11px] uppercase tracking-[0.12em] text-text-muted">{t('hub.landing.preview.online')}</span>
        {['Kaya', 'Mira', 'Theo'].map((name) => (
          <span key={name} className="text-sm text-text-primary">
            {name}
          </span>
        ))}
        <span className="flex items-center gap-2 text-sm text-text-primary">
          {t('hub.landing.preview.welcomeBot')}
          <BotBadge t={t} />
        </span>
        <span className={`mt-auto rounded-[14px] bg-success/10 p-3 text-[13px] ${tones.success}`}>
          {t('hub.landing.preview.doctor')}
        </span>
      </div>
    </div>
  );
}

function BotBadge({ t }: { t: Translator }) {
  return (
    <span className="flex h-[18px] items-center rounded-md bg-primary/15 px-1.5 text-[10px] font-bold uppercase text-primary">
      {t('hub.landing.preview.bot')}
    </span>
  );
}
