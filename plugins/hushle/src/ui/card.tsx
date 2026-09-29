'use client';

import { useId, type ReactNode } from 'react';
import { lf, tone } from '@lobbyforge/plugin-sdk/ui';
import type { HushleCard } from '../state';
import { useHushleI18n } from './i18n';
import { categoryName, difficultyName } from './labels';
import { VisuallyHidden } from './parts';
import { DISPLAY_FONT, difficultyColours, difficultyOf } from './theme';

/**
 * The card the explainer describes and the other team watches.
 *
 * Its words are in the PACK's language, which need not be the panel's (an
 * English game in a Turkish app), so the word and the forbidden list carry
 * `lang={card.language}`: uppercase "şişe" is then "ŞİŞE", not "ŞIŞE", and
 * screen readers pronounce the word in the right language. Translated
 * labels on the card keep the panel's language.
 */
export function CardFace({ card }: { card: HushleCard }) {
  const { t } = useHushleI18n();
  const forbiddenId = useId();
  const level = difficultyOf(card.difficulty);
  const colours = difficultyColours(level);
  const category = card.category ? categoryName(card.category, t) : null;

  return (
    <article
      className="hushle-card lfui-pop"
      aria-label={t('hushle.card.label')}
      style={{
        flex: '1 1 auto',
        minWidth: 0,
        borderRadius: 22,
        background: lf.raised,
        border: `2px solid ${colours.line}`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div aria-hidden="true" style={{ height: 8, flexShrink: 0, background: colours.bar }} />
      <div style={{ flex: '1 1 auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {category ? (
            <span
              style={{
                minHeight: 26,
                boxSizing: 'border-box',
                padding: '3px 10px',
                borderRadius: 99,
                background: lf.surface,
                color: lf.text2,
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <VisuallyHidden>{t('hushle.card.category')} </VisuallyHidden>
              <span lang={category.translated ? undefined : card.language}>{category.text}</span>
            </span>
          ) : (
            <span />
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: colours.text,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            <VisuallyHidden>{t('hushle.card.difficulty')} </VisuallyHidden>
            {difficultyName(level, t)}
            <span aria-hidden="true" style={{ display: 'inline-flex', gap: 3 }}>
              {[0, 1, 2].map((pip) => (
                <span
                  key={pip}
                  data-pip={pip < colours.pips ? 'on' : 'off'}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: pip < colours.pips ? colours.bar : 'var(--hushle-pip-off)',
                  }}
                />
              ))}
            </span>
          </span>
        </div>

        <p
          className="hushle-word"
          lang={card.language}
          style={{
            flex: '1 1 auto',
            margin: 0,
            padding: '18px 0 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            fontFamily: DISPLAY_FONT,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            textTransform: 'uppercase',
          }}
        >
          {card.word}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span
            id={forbiddenId}
            style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: lf.muted, textAlign: 'center' }}
          >
            {t('hushle.playing.forbiddenWords')}
          </span>
          <ul
            aria-labelledby={forbiddenId}
            lang={card.language}
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {card.forbiddenWords.map((word, index) => (
              <li
                key={`${index}:${word}`}
                style={{
                  minHeight: 40,
                  boxSizing: 'border-box',
                  padding: '6px 12px',
                  borderRadius: 12,
                  background: lf.surface,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  overflowWrap: 'anywhere',
                  fontSize: 16,
                  fontWeight: 500,
                  color: tone('danger').text,
                  textDecoration: 'line-through',
                  textDecorationColor: 'var(--hushle-strike)',
                  textTransform: 'capitalize',
                }}
              >
                {word}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

/**
 * Where the card would be, for a viewer who must not see it (the
 * explainer's teammates, the floater, spectators) or when there is none.
 */
export function HiddenCard({ icon, title, body }: { icon: ReactNode; title: ReactNode; body?: ReactNode }) {
  return (
    <div
      className="hushle-card"
      style={{
        flex: '1 1 auto',
        minHeight: 300,
        boxSizing: 'border-box',
        padding: 28,
        borderRadius: 22,
        border: `2px dashed ${lf.borderStrong}`,
        background: lf.sunken,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        textAlign: 'center',
      }}
    >
      <span aria-hidden="true" style={{ color: lf.muted }}>
        {icon}
      </span>
      <p style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{title}</p>
      {body ? <p style={{ margin: 0, maxWidth: 360, fontSize: 15, lineHeight: 1.5, color: lf.text2 }}>{body}</p> : null}
    </div>
  );
}
