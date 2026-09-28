import type { HushleDifficulty } from '../state';
import type { Translate } from './i18n';
import {
  knownName,
  type DifficultyPreset,
  type PanelPlayer,
  type PlayRole,
  type TurnOutcome,
} from './model';

/**
 * Words the panel picks by value. Each key is spelled out so the locales
 * test can see it; a lookup built from the value (`hushle.difficulty.${x}`)
 * would hide the key from it.
 */

export function difficultyName(level: HushleDifficulty, t: Translate): string {
  switch (level) {
    case 'hard':
      return t('hushle.difficulty.hard');
    case 'medium':
      return t('hushle.difficulty.medium');
    default:
      return t('hushle.difficulty.easy');
  }
}

/**
 * The built-in packs tag cards with category slugs; a custom pack may use
 * any text. Known slugs are translated, anything else is shown as written
 * (it is pack data, in the pack's language).
 */
export function categoryName(category: string, t: Translate): { text: string; translated: boolean } {
  const text = (() => {
    switch (category) {
      case 'food-drink':
        return t('hushle.category.foodDrink');
      case 'arts':
        return t('hushle.category.arts');
      case 'places':
        return t('hushle.category.places');
      case 'nature':
        return t('hushle.category.nature');
      case 'technology':
        return t('hushle.category.technology');
      case 'sports':
        return t('hushle.category.sports');
      case 'travel':
        return t('hushle.category.travel');
      case 'objects':
        return t('hushle.category.objects');
      case 'transport':
        return t('hushle.category.transport');
      case 'history':
        return t('hushle.category.history');
      case 'animals':
        return t('hushle.category.animals');
      case 'general':
        return t('hushle.category.general');
      default:
        return null;
    }
  })();
  return text === null ? { text: category, translated: false } : { text, translated: true };
}

export function outcomeName(outcome: TurnOutcome, t: Translate): string {
  switch (outcome) {
    case 'correct':
      return t('hushle.turn.correct');
    case 'pass':
      return t('hushle.turn.pass');
    case 'penalty':
      return t('hushle.turn.penalty');
    default:
      return t('hushle.turn.next');
  }
}

export function presetName(preset: DifficultyPreset, t: Translate): string {
  switch (preset) {
    case 'easier':
      return t('hushle.settings.difficultyEasier');
    case 'harder':
      return t('hushle.settings.difficultyHarder');
    default:
      return t('hushle.settings.difficultyMixed');
  }
}

/** The line above the card: what this viewer is doing this turn. */
export function roleLine(role: PlayRole, isHost: boolean, t: Translate): string {
  switch (role) {
    case 'explainer':
      return t('hushle.playing.youAreExplainer');
    case 'guesser':
      return t('hushle.playing.youAreGuesser');
    case 'opponent':
      return t('hushle.playing.youAreOpponent');
    case 'floater':
      return t('hushle.playing.youAreFloater');
    default:
      return isHost ? t('hushle.playing.youAreHost') : t('hushle.playing.youAreSpectator');
  }
}

/**
 * A player's name. The panel remembers every name it has been given this
 * session, so this falls back to "Unknown player" only for someone it
 * never saw — never to their raw id.
 */
export function playerName(players: PanelPlayer[], userId: string, t: Translate): string {
  return knownName(players, userId) ?? t('hushle.player.unnamed');
}
