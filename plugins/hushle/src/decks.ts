/**
 * Built-in Hushle card decks.
 *
 * Two layers:
 *
 * 1. `HUSHLE_BUILTIN_PACKS` — structured pack seeds (slug, name, language,
 *    description, cards) that the host seeds into the `card_packs` +
 *    `cards` tables on first boot. Each card carries its
 *    `forbiddenWords` in the plugin-defined `payload` JSONB and a
 *    `difficulty` tier (easy / medium / hard) for the M20a weighted
 *    draw routine.
 *
 * 2. `getDefaultDeck(language)` — the legacy in-code fallback that
 *    builds a HushleCard[] from a language string. Kept for backward
 *    compatibility with M17 callers that pass `language` to
 *    `start-game` without a `packId`. Maps `language` to the
 *    matching built-in pack's cards.
 *
 * The MVP ship is the bundled 24-card en + tr packs. The full deck
 * model (DB-backed card packs, custom packs, community packs) lands
 * with M18; the M18 work is what makes the `card_packs` table real.
 *
 * Words are deliberately everyday-noun so the explainer has room to
 * describe without falling back to a forbidden word.
 *
 * M20a — each card now carries a `difficulty` tier. The 24 cards in
 * each language are distributed approximately 60% easy / 30% medium /
 * 10% hard (so 14 easy / 7 medium / 3 hard per language). The visual
 * treatment (color + icon) is plugin-owned — the host only stores
 * the label and the reducer's weighted draw picks tiers based on
 * `settings.difficultyDistribution`.
 */

import type { BuiltInPackSeed } from '@lobbyforge/db';
import type { HushleCard, HushleDifficulty, HushleLanguage } from './state';

/**
 * Card seeds. The third field is the difficulty tier. Distribution is
 * 60/30/10 (14/7/3 of 24). Tier choices are deliberately mixed so
 * adjacent cards in the deck aren't all the same colour — the host
 * UI shuffles the deck on draw anyway.
 */
type CardSeed = { word: string; forbidden: string[]; difficulty: HushleDifficulty };

const categories = [
  'food-drink', 'food-drink', 'arts', 'food-drink', 'places', 'arts',
  'nature', 'technology', 'sports', 'nature', 'food-drink', 'travel',
  'technology', 'objects', 'transport', 'nature', 'technology', 'transport',
  'places', 'nature', 'travel', 'nature', 'history', 'animals',
] as const;

const enCards: CardSeed[] = [
  // 14 easy — common, concrete, everyday nouns.
  { word: 'apple', forbidden: ['fruit', 'red', 'pie', 'tree', 'core'], difficulty: 'easy' },
  { word: 'coffee', forbidden: ['cup', 'drink', 'bean', 'morning', 'espresso'], difficulty: 'easy' },
  { word: 'guitar', forbidden: ['music', 'string', 'play', 'instrument', 'rock'], difficulty: 'easy' },
  { word: 'pizza', forbidden: ['cheese', 'italian', 'slice', 'oven', 'pepperoni'], difficulty: 'easy' },
  { word: 'beach', forbidden: ['sand', 'sea', 'sun', 'wave', 'swim'], difficulty: 'easy' },
  { word: 'book', forbidden: ['read', 'page', 'story', 'library', 'author'], difficulty: 'easy' },
  { word: 'moon', forbidden: ['night', 'sky', 'sun', 'earth', 'crater'], difficulty: 'easy' },
  { word: 'phone', forbidden: ['call', 'mobile', 'screen', 'app', 'message'], difficulty: 'easy' },
  { word: 'soccer', forbidden: ['ball', 'goal', 'kick', 'field', 'team'], difficulty: 'easy' },
  { word: 'rain', forbidden: ['cloud', 'water', 'wet', 'storm', 'umbrella'], difficulty: 'easy' },
  { word: 'cake', forbidden: ['birthday', 'sweet', 'bake', 'frosting', 'candle'], difficulty: 'easy' },
  { word: 'suitcase', forbidden: ['travel', 'bag', 'trip', 'pack', 'luggage'], difficulty: 'easy' },
  { word: 'camera', forbidden: ['photo', 'lens', 'picture', 'shoot', 'film'], difficulty: 'easy' },
  { word: 'mirror', forbidden: ['reflect', 'glass', 'look', 'face', 'image'], difficulty: 'easy' },
  // 7 medium — slightly less common or harder to describe without
  // treading on a forbidden word.
  { word: 'bicycle', forbidden: ['wheel', 'pedal', 'bike', 'ride', 'chain'], difficulty: 'medium' },
  { word: 'rainbow', forbidden: ['color', 'sky', 'rain', 'arc', 'pot'], difficulty: 'medium' },
  { word: 'computer', forbidden: ['screen', 'keyboard', 'mouse', 'code', 'laptop'], difficulty: 'medium' },
  { word: 'airplane', forbidden: ['fly', 'wing', 'pilot', 'sky', 'airport'], difficulty: 'medium' },
  { word: 'bridge', forbidden: ['river', 'cross', 'road', 'span', 'arch'], difficulty: 'medium' },
  { word: 'forest', forbidden: ['tree', 'wood', 'animal', 'green', 'path'], difficulty: 'medium' },
  { word: 'compass', forbidden: ['north', 'direction', 'magnet', 'map', 'needle'], difficulty: 'medium' },
  // 3 hard — abstract or niche. Explainer has to work for it.
  { word: 'volcano', forbidden: ['lava', 'mountain', 'erupt', 'fire', 'magma'], difficulty: 'hard' },
  { word: 'pyramid', forbidden: ['egypt', 'triangle', 'tomb', 'pharaoh', 'desert'], difficulty: 'hard' },
  { word: 'elephant', forbidden: ['trunk', 'big', 'gray', 'tusk', 'africa'], difficulty: 'hard' },
];

const trCards: CardSeed[] = [
  { word: 'elma', forbidden: ['meyve', 'kırmızı', 'ağaç', 'bahçe', 'pasta'], difficulty: 'easy' },
  { word: 'kahve', forbidden: ['iç', 'fincan', 'çekirdek', 'sabah', 'türk'], difficulty: 'easy' },
  { word: 'gitar', forbidden: ['müzik', 'tel', 'çalgı', 'şarkı', 'akustik'], difficulty: 'easy' },
  { word: 'pizza', forbidden: ['peynir', 'italyan', 'dilim', 'fırın', 'sucuk'], difficulty: 'easy' },
  { word: 'plaj', forbidden: ['kum', 'deniz', 'güneş', 'dalga', 'yüz'], difficulty: 'easy' },
  { word: 'kitap', forbidden: ['oku', 'sayfa', 'hikaye', 'kütüphane', 'yazar'], difficulty: 'easy' },
  { word: 'ay', forbidden: ['gece', 'gökyüzü', 'güneş', 'dünya', 'yıldız'], difficulty: 'easy' },
  { word: 'telefon', forbidden: ['ara', 'ekran', 'mesaj', 'uygulama', 'şarj'], difficulty: 'easy' },
  { word: 'futbol', forbidden: ['top', 'gol', 'vur', 'saha', 'takım'], difficulty: 'easy' },
  { word: 'yağmur', forbidden: ['bulut', 'su', 'ıslak', 'fırtına', 'şemsiye'], difficulty: 'easy' },
  { word: 'pasta', forbidden: ['doğum', 'tatlı', 'firın', 'krem', 'mum'], difficulty: 'easy' },
  { word: 'bavul', forbidden: ['seyahat', 'çanta', 'yolculuk', 'topla', 'valiz'], difficulty: 'easy' },
  { word: 'kamera', forbidden: ['foto', 'mercek', 'çek', 'film', 'görüntü'], difficulty: 'easy' },
  { word: 'ayna', forbidden: ['yansı', 'cam', 'bak', 'yüz', 'görüntü'], difficulty: 'easy' },
  { word: 'bisiklet', forbidden: ['tekerlek', 'pedal', 'sür', 'zincir', 'kask'], difficulty: 'medium' },
  { word: 'gökkuşağı', forbidden: ['renk', 'gökyüzü', 'yağmur', 'yay', 'gök'], difficulty: 'medium' },
  { word: 'bilgisayar', forbidden: ['ekran', 'klavye', 'fare', 'kod', 'dizüstü'], difficulty: 'medium' },
  { word: 'uçak', forbidden: ['uç', 'kanat', 'pilot', 'gökyüzü', 'havalimanı'], difficulty: 'medium' },
  { word: 'köprü', forbidden: ['nehir', 'geç', 'yol', 'ayak', 'kanat'], difficulty: 'medium' },
  { word: 'orman', forbidden: ['ağaç', 'yeşil', 'hayvan', 'yol', 'ağaçkakan'], difficulty: 'medium' },
  { word: 'pusula', forbidden: ['kuzey', 'yön', 'mıknatıs', 'harita', 'iğne'], difficulty: 'medium' },
  { word: 'yanardağ', forbidden: ['lav', 'dağ', 'patla', 'ateş', 'magma'], difficulty: 'hard' },
  { word: 'piramit', forbidden: ['mısır', 'üçgen', 'mezar', 'firavun', 'çöl'], difficulty: 'hard' },
  { word: 'fil', forbidden: ['hortum', 'büyük', 'gri', 'diş', 'afrika'], difficulty: 'hard' },
];

export const HUSHLE_BUILTIN_PACKS: BuiltInPackSeed[] = [
  {
    slug: 'hushle-en-basic',
    name: 'Hushle — English (Basic)',
    language: 'en',
    description: '24 everyday English words for the M17 Hushle MVP. M20a distribution: 14 easy / 7 medium / 3 hard.',
    cards: enCards.map((c, index) => ({
      word: c.word,
      forbiddenWords: c.forbidden,
      difficulty: c.difficulty,
      category: categories[index] ?? 'general',
    })),
  },
  {
    slug: 'hushle-tr-basic',
    name: 'Hushle — Türkçe (Temel)',
    language: 'tr',
    description: '24 günlük Türkçe kelime — Hushle M17 temel paketi. M20a dağılım: 14 kolay / 7 orta / 3 zor.',
    cards: trCards.map((c, index) => ({
      word: c.word,
      forbiddenWords: c.forbidden,
      difficulty: c.difficulty,
      category: categories[index] ?? 'general',
    })),
  },
];

let counter = 0;
function cardId(): string {
  counter += 1;
  return `card-${counter.toString(36)}`;
}

export function getDefaultDeck(language: HushleLanguage): HushleCard[] {
  counter = 0;
  const source = language === 'tr' ? trCards : enCards;
  return source.map((c, index) => ({
    id: cardId(),
    language,
    word: c.word,
    forbiddenWords: c.forbidden,
    difficulty: c.difficulty,
    category: categories[index] ?? 'general',
  }));
}

export function getDefaultPackSlugForLanguage(language: HushleLanguage): string {
  return language === 'tr' ? 'hushle-tr-basic' : 'hushle-en-basic';
}

export function getLanguageForPackSlug(slug: string): HushleLanguage | null {
  if (slug === 'hushle-tr-basic') return 'tr';
  if (slug === 'hushle-en-basic') return 'en';
  return null;
}
