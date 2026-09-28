'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Grid,
  Panel,
  PhasePill,
  SectionLabel,
  SegmentedControl,
  Stack,
  lf,
  tone,
} from '@lobbyforge/plugin-sdk/ui';
import { autonym, languageName, useHushleI18n } from './i18n';
import { presetName } from './labels';
import {
  CARDS_PER_TURN_OPTIONS,
  DEFAULT_SETUP,
  DIFFICULTY_PRESETS,
  DIFFICULTY_PRESET_ORDER,
  FALLBACK_PACK_BY_LANGUAGE,
  TEAM_SIZE_OPTIONS,
  TURN_TIMER_OPTIONS,
  percentages,
  startGameAction,
  type DifficultyPreset,
} from './model';
import { ChoiceTile, Field, PeopleIcon } from './parts';
import { HushleHeader, isHostViewer, type ViewProps } from './shared';

/** A word pack the host can start a game with (from `/api/servers/{id}/card-packs`). */
export interface LobbyCardPack {
  id: string;
  slug: string;
  name: string;
  /** The pack's language — any language tag, not only en/tr. */
  language: string;
  cardCount: number;
  isBuiltIn: boolean;
}

/** The pack a host most likely wants: one in their own language, else the first. */
function defaultPack(packs: LobbyCardPack[], locale: string): LobbyCardPack | null {
  const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];
  return packs.find((pack) => base(pack.language) === base(locale)) ?? packs[0] ?? null;
}

export function LobbyView({ cardPacks, ...props }: ViewProps & { cardPacks?: LobbyCardPack[] }) {
  const { t } = useHushleI18n();
  const isHost = isHostViewer(props);
  const { dispatch, actorUserId } = props;
  const setup = useLobbySetup(cardPacks);

  return (
    <>
      <HushleHeader
        hostUserId={props.hostUserId}
        players={props.players}
        detail={t('hushle.tagline')}
        status={<PhasePill tone="info">{t('hushle.phase.lobby')}</PhasePill>}
        actions={
          isHost ? (
            <Button variant="primary" onClick={() => void dispatch(startGameAction(setup.action, actorUserId))}>
              {t('hushle.lobby.startButton')}
            </Button>
          ) : null
        }
      />
      <Grid min={320} gap={18}>
        {isHost ? <SettingsPanel setup={setup} /> : <WaitingForHost />}
        <HowToPlay />
      </Grid>
    </>
  );
}

type LobbySetup = ReturnType<typeof useLobbySetup>;

function useLobbySetup(cardPacks: LobbyCardPack[] | undefined) {
  const { locale } = useHushleI18n();
  // Prefer the host's card-pack list (DB-backed, includes community packs).
  // Fall back to the built-in languages if no packs are available.
  const packs = Array.isArray(cardPacks) ? cardPacks : [];
  const hasPacks = packs.length > 0;
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  const [fallbackLanguage, setFallbackLanguage] = useState<'en' | 'tr'>(locale === 'tr' ? 'tr' : 'en');
  const [turnDurationSeconds, setTurnDuration] = useState<number>(DEFAULT_SETUP.turnDurationSeconds);
  const [cardsPerTurn, setCardsPerTurn] = useState<number>(DEFAULT_SETUP.cardsPerTurn);
  const [teamSize, setTeamSize] = useState<number>(DEFAULT_SETUP.teamSize);
  const [difficulty, setDifficulty] = useState<DifficultyPreset>('mixed');

  // The pack list can arrive after the panel mounts; a choice that is not
  // (or no longer) in it falls back to the default instead of pointing at
  // nothing.
  const selectedPack = hasPacks
    ? packs.find((pack) => pack.slug === chosenSlug) ?? defaultPack(packs, locale)
    : null;
  const packId = selectedPack?.slug ?? FALLBACK_PACK_BY_LANGUAGE[fallbackLanguage];
  const language = selectedPack?.language ?? fallbackLanguage;

  return {
    packs,
    hasPacks,
    selectedPack,
    choosePack: setChosenSlug,
    fallbackLanguage,
    setFallbackLanguage,
    turnDurationSeconds,
    setTurnDuration,
    cardsPerTurn,
    setCardsPerTurn,
    teamSize,
    setTeamSize,
    difficulty,
    setDifficulty,
    action: {
      packId,
      language,
      turnDurationSeconds,
      cardsPerTurn,
      teamSize,
      difficultyDistribution: DIFFICULTY_PRESETS[difficulty],
    },
  };
}

function SettingsPanel({ setup }: { setup: LobbySetup }) {
  const { t, locale } = useHushleI18n();
  const mix = percentages(DIFFICULTY_PRESETS[setup.difficulty]);
  return (
    <Panel>
      <Stack gap={20}>
        <Stack gap={6}>
          <SectionLabel>{t('hushle.lobby.settingsTitle')}</SectionLabel>
          <span style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.lobby.hostPrompt')}</span>
        </Stack>

        {setup.hasPacks ? (
          <Field label={t('hushle.lobby.packLabel')}>
            <div role="group" aria-label={t('hushle.lobby.packLabel')}>
              <Grid min={200} gap={10}>
                {setup.packs.map((pack) => (
                  <ChoiceTile
                    key={pack.id}
                    selected={setup.selectedPack?.slug === pack.slug}
                    onSelect={() => setup.choosePack(pack.slug)}
                  >
                    <span lang={pack.language} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {pack.name}
                    </span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, color: lf.text2 }}>
                      <span>{languageName(pack.language, locale)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t('hushle.lobby.packCards', { count: pack.cardCount })}</span>
                      <Badge tone={pack.isBuiltIn ? 'neutral' : 'info'}>
                        {pack.isBuiltIn ? t('hushle.lobby.packBuiltIn') : t('hushle.lobby.packCustom')}
                      </Badge>
                    </span>
                  </ChoiceTile>
                ))}
              </Grid>
            </div>
          </Field>
        ) : (
          <Field label={t('hushle.lobby.language')}>
            <SegmentedControl
              label={t('hushle.lobby.language')}
              value={setup.fallbackLanguage}
              onChange={setup.setFallbackLanguage}
              options={(['en', 'tr'] as const).map((code) => ({
                value: code,
                label: <span lang={code}>{autonym(code)}</span>,
              }))}
            />
          </Field>
        )}

        <Field label={t('hushle.lobby.turnDuration')} hint={t('hushle.lobby.turnDurationHint')}>
          <SegmentedControl
            label={t('hushle.lobby.turnDuration')}
            value={String(setup.turnDurationSeconds)}
            onChange={(value) => setup.setTurnDuration(Number(value))}
            options={TURN_TIMER_OPTIONS.map((seconds) => ({
              value: String(seconds),
              label: t('hushle.settings.seconds', { count: seconds }),
            }))}
          />
        </Field>

        <Field label={t('hushle.lobby.cardsPerTurn')}>
          <SegmentedControl
            label={t('hushle.lobby.cardsPerTurn')}
            value={String(setup.cardsPerTurn)}
            onChange={(value) => setup.setCardsPerTurn(Number(value))}
            options={CARDS_PER_TURN_OPTIONS.map((count) => ({ value: String(count), label: String(count) }))}
          />
        </Field>

        <Field label={t('hushle.lobby.teamSize')} hint={t('hushle.lobby.teamSizeHint')}>
          <SegmentedControl
            label={t('hushle.lobby.teamSize')}
            value={String(setup.teamSize)}
            onChange={(value) => setup.setTeamSize(Number(value))}
            options={TEAM_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) }))}
          />
        </Field>

        <Field
          label={t('hushle.lobby.difficulty')}
          hint={t('hushle.settings.mix', { easy: mix.easy, medium: mix.medium, hard: mix.hard })}
        >
          <SegmentedControl
            label={t('hushle.lobby.difficulty')}
            value={setup.difficulty}
            onChange={setup.setDifficulty}
            options={DIFFICULTY_PRESET_ORDER.map((preset) => ({ value: preset, label: presetName(preset, t) }))}
          />
        </Field>
      </Stack>
    </Panel>
  );
}

function WaitingForHost() {
  const { t } = useHushleI18n();
  return (
    <div role="status" style={{ alignSelf: 'start' }}>
      <EmptyState icon={<PeopleIcon />} title={t('hushle.lobby.waitingForHost')} body={t('hushle.lobby.waitingBody')} />
    </div>
  );
}

/** The rules in four lines — what the reducer actually scores. */
function HowToPlay() {
  const { t } = useHushleI18n();
  const steps = [t('hushle.howTo.teams'), t('hushle.howTo.explain'), t('hushle.howTo.bust'), t('hushle.howTo.score')];
  return (
    <Panel style={{ alignSelf: 'start' }}>
      <Stack gap={14}>
        <SectionLabel>{t('hushle.howTo.title')}</SectionLabel>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {steps.map((step, index) => (
            <li key={index} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span
                aria-hidden="true"
                style={{
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  borderRadius: 99,
                  background: lf.raised,
                  border: `1px solid ${lf.border}`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  color: tone('game').text,
                }}
              >
                {index + 1}
              </span>
              <span style={{ fontSize: 14, lineHeight: 1.55, color: lf.text2, paddingTop: 4 }}>{step}</span>
            </li>
          ))}
        </ol>
      </Stack>
    </Panel>
  );
}
