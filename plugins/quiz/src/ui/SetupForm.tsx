'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Callout, Grid, Panel, SectionLabel, SegmentedControl, Stack, lf, tone } from '@lobbyforge/plugin-sdk/ui';
import { parseCustomQuestions, type QuizParseError } from '../custom';
import { defaultQuizPack, quizPacksForLocale, type QuizPackSummary } from '../packs';
import {
  QUIZ_DEFAULT_QUESTION_COUNT,
  QUIZ_DEFAULT_SECONDS,
  QUIZ_QUESTION_COUNTS,
  QUIZ_SECONDS_OPTIONS,
  type QuizSource,
} from '../state';
import type { QuizUi, Translate } from './context';
import { nativeLanguageName } from './helpers';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <Stack gap={8}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint ? <span style={{ fontSize: 13, color: lf.muted }}>{hint}</span> : null}
    </Stack>
  );
}

function parseErrorText(t: Translate, error: QuizParseError): string {
  const number = error.question ?? 1;
  switch (error.code) {
    case 'empty':
      return t('quiz.setup.custom.empty');
    case 'tooMany':
      return t('quiz.setup.custom.tooMany');
    case 'noQuestion':
      return t('quiz.setup.custom.noQuestion', { number });
    case 'tooFewOptions':
      return t('quiz.setup.custom.tooFewOptions', { number });
    case 'tooManyOptions':
      return t('quiz.setup.custom.tooManyOptions', { number });
    case 'noCorrect':
      return t('quiz.setup.custom.noCorrect', { number });
    case 'manyCorrect':
      return t('quiz.setup.custom.manyCorrect', { number });
    case 'duplicateOption':
      return t('quiz.setup.custom.duplicateOption', { number });
    case 'tooLong':
      return t('quiz.setup.custom.tooLong', { number });
    default:
      return t('quiz.setup.custom.invalidJson');
  }
}

function PackCard({
  pack,
  selected,
  onSelect,
  t,
}: {
  pack: QuizPackSummary;
  selected: boolean;
  onSelect: () => void;
  t: Translate;
}) {
  const accent = tone('accent');
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="lfui-option lfui-focus"
      style={{
        boxSizing: 'border-box',
        padding: 16,
        borderRadius: 16,
        border: `2px solid ${selected ? accent.fill : lf.border}`,
        background: selected ? accent.soft : lf.raised,
        color: lf.text,
        font: 'inherit',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span lang={pack.language} style={{ fontSize: 16, fontWeight: 600 }}>
        {pack.title}
      </span>
      <span lang={pack.language} style={{ fontSize: 13, lineHeight: 1.45, color: lf.text2 }}>
        {pack.description}
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 'auto' }}>
        <Badge tone={selected ? 'accent' : 'neutral'}>
          <span lang={pack.language}>{nativeLanguageName(pack.language)}</span>
        </Badge>
        <span style={{ fontSize: 12, color: lf.muted }}>{t('quiz.setup.packQuestions', { count: pack.questionCount })}</span>
      </span>
    </button>
  );
}

/** The host's setup: source, pack or pasted questions, count, timer, shuffle, start. */
export function SetupForm({ ui, playerCount, hostIsPlaying }: { ui: QuizUi; playerCount: number; hostIsPlaying: boolean }) {
  const { t } = ui;
  const packs = useMemo(() => quizPacksForLocale(ui.locale), [ui.locale]);
  const [source, setSource] = useState<QuizSource>('pack');
  const [packKey, setPackKey] = useState(() => {
    const first = defaultQuizPack(ui.locale);
    return `${first.id}:${first.language}`;
  });
  const [count, setCount] = useState<number>(QUIZ_DEFAULT_QUESTION_COUNT);
  const [seconds, setSeconds] = useState<number>(QUIZ_DEFAULT_SECONDS);
  const [shuffle, setShuffle] = useState(true);
  const [customText, setCustomText] = useState('');
  const customId = useId();
  const customHelpId = useId();

  const mine = packs.filter((pack) => pack.language === packs[0]?.language);
  const others = packs.filter((pack) => pack.language !== packs[0]?.language);
  const parsed = useMemo(() => (source === 'custom' ? parseCustomQuestions(customText) : null), [source, customText]);
  const selectedPack = packs.find((pack) => `${pack.id}:${pack.language}` === packKey) ?? packs[0]!;

  const customReady = parsed?.ok ? parsed.questions.length : 0;
  const problem =
    playerCount === 0
      ? t('quiz.setup.needPlayers')
      : source === 'custom' && !parsed?.ok
        ? t('quiz.setup.needQuestions')
        : null;

  const start = () => {
    if (problem) return;
    if (source === 'pack') {
      ui.dispatch({
        type: 'start',
        source: 'pack',
        packId: selectedPack.id,
        language: selectedPack.language,
        questionCount: count,
        secondsPerQuestion: seconds,
        shuffle,
      });
    } else if (parsed?.ok) {
      ui.dispatch({
        type: 'start',
        source: 'custom',
        questions: parsed.questions,
        questionCount: count,
        secondsPerQuestion: seconds,
        shuffle,
      });
    }
  };

  const packGrid = (list: QuizPackSummary[]) => (
    <Grid min={170} gap={10}>
      {list.map((pack) => {
        const key = `${pack.id}:${pack.language}`;
        return <PackCard key={key} pack={pack} selected={key === packKey} onSelect={() => setPackKey(key)} t={t} />;
      })}
    </Grid>
  );

  return (
    <Panel>
      <Stack gap={20}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('quiz.setup.title')}</h3>

        <Field label={t('quiz.setup.sourceLabel')}>
          <SegmentedControl<QuizSource>
            label={t('quiz.setup.sourceLabel')}
            value={source}
            onChange={setSource}
            options={[
              { value: 'pack', label: t('quiz.setup.sourcePack') },
              { value: 'custom', label: t('quiz.setup.sourceCustom') },
            ]}
          />
        </Field>

        {source === 'pack' ? (
          <div role="group" aria-label={t('quiz.setup.packsLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {packGrid(mine)}
            {others.length > 0 ? (
              <>
                <SectionLabel>{t('quiz.setup.otherLanguages')}</SectionLabel>
                {packGrid(others)}
              </>
            ) : null}
          </div>
        ) : (
          <Stack gap={10}>
            <label htmlFor={customId} style={{ fontSize: 14, fontWeight: 600 }}>
              {t('quiz.setup.customLabel')}
            </label>
            <textarea
              id={customId}
              className="lfui-focus"
              value={customText}
              onChange={(event) => setCustomText(event.target.value)}
              aria-describedby={customHelpId}
              rows={9}
              spellCheck
              placeholder={t('quiz.setup.customPlaceholder')}
              style={{
                boxSizing: 'border-box',
                width: '100%',
                minHeight: 180,
                padding: 14,
                borderRadius: 14,
                border: `1px solid ${lf.borderStrong}`,
                background: lf.sunken,
                color: lf.text,
                font: 'inherit',
                fontSize: 14,
                lineHeight: 1.5,
                resize: 'vertical',
              }}
            />
            <span id={customHelpId} style={{ fontSize: 13, lineHeight: 1.5, color: lf.muted }}>
              {t('quiz.setup.customHelp')}
            </span>
            <div role="status">
              {customText.trim() === '' ? null : parsed?.ok ? (
                <Callout tone="success">
                  {t('quiz.setup.customReady', { count: customReady })}
                  {customReady > count ? ` ${t('quiz.setup.customAsked', { asked: count })}` : ''}
                </Callout>
              ) : parsed ? (
                <Callout tone="danger">{parseErrorText(t, parsed.error)}</Callout>
              ) : null}
            </div>
            {hostIsPlaying ? <Callout tone="info">{t('quiz.setup.customHostHint')}</Callout> : null}
          </Stack>
        )}

        <Field label={t('quiz.setup.countLabel')}>
          <SegmentedControl<string>
            label={t('quiz.setup.countLabel')}
            value={String(count)}
            onChange={(value) => setCount(Number(value))}
            options={QUIZ_QUESTION_COUNTS.map((value) => ({ value: String(value), label: ui.number(value) }))}
          />
        </Field>

        <Field label={t('quiz.setup.secondsLabel')}>
          <SegmentedControl<string>
            label={t('quiz.setup.secondsLabel')}
            value={String(seconds)}
            onChange={(value) => setSeconds(Number(value))}
            options={QUIZ_SECONDS_OPTIONS.map((value) => ({ value: String(value), label: t('quiz.setup.seconds', { count: value }) }))}
          />
        </Field>

        <Field label={t('quiz.setup.shuffleLabel')} hint={t('quiz.setup.shuffleHint')}>
          <SegmentedControl<'on' | 'off'>
            label={t('quiz.setup.shuffleLabel')}
            value={shuffle ? 'on' : 'off'}
            onChange={(value) => setShuffle(value === 'on')}
            options={[
              { value: 'on', label: t('quiz.setup.shuffleOn') },
              { value: 'off', label: t('quiz.setup.shuffleOff') },
            ]}
          />
        </Field>

        {problem ? <Callout tone="neutral">{problem}</Callout> : null}
        <Button variant="primary" size="lg" block disabled={problem !== null} onClick={start}>
          {t('quiz.setup.start')}
        </Button>
      </Stack>
    </Panel>
  );
}
