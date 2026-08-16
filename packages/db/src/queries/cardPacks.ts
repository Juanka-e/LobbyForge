import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { cardPacks, cards } from '../schema.js';

export interface CardPackRow {
  id: string;
  pluginId: string;
  slug: string;
  name: string;
  language: string;
  description: string | null;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CardPackSummary extends CardPackRow {
  cardCount: number;
}

export interface CardRow {
  id: string;
  packId: string;
  ordinal: number;
  payload: Record<string, unknown>;
  difficulty: string;
  category: string;
  createdAt: Date;
}

export interface CreateCardPackInput {
  pluginId: string;
  slug: string;
  name: string;
  language: string;
  description?: string | null;
  isBuiltIn?: boolean;
}

export interface BuiltInCardSeed {
  word: string;
  forbiddenWords: string[];
  /**
   * Difficulty tier label (plugin-defined). Hushle uses the conventional
   * `easy` / `medium` / `hard`; other plugins can use any string. The
   * seed library defaults to `easy` so a pack author who doesn't care
   * doesn't have to repeat it on every card.
   */
  difficulty?: string;
  /** Searchable plugin-defined category. Defaults to `general`. */
  category?: string;
}

export interface BuiltInPackSeed {
  slug: string;
  name: string;
  language: string;
  description: string;
  /**
   * Optional default difficulty for cards in this pack that don't carry
   * their own. Useful when an entire pack is one tier (e.g. a kids'
   * deck is all-easy). Per-card `difficulty` always wins.
   */
  defaultDifficulty?: string;
  cards: BuiltInCardSeed[];
}

export async function listCardPacks(db: DbClient, pluginId?: string): Promise<CardPackRow[]> {
  const query = db.select().from(cardPacks);
  const rows = pluginId
    ? await query.where(eq(cardPacks.pluginId, pluginId)).orderBy(asc(cardPacks.name))
    : await query.orderBy(asc(cardPacks.pluginId), asc(cardPacks.name));
  return rows as CardPackRow[];
}

export async function listCardPackSummaries(
  db: DbClient,
  pluginId?: string
): Promise<CardPackSummary[]> {
  const packs = await listCardPacks(db, pluginId);
  if (packs.length === 0) return [];
  // One aggregated round-trip (COUNT(*) GROUP BY pack_id) instead of
  // loading every card row just to count them.
  const countRows = await db
    .select({ packId: cards.packId, count: sql<number>`count(*)::int` })
    .from(cards)
    .groupBy(cards.packId);
  const countMap = new Map<string, number>(countRows.map((r) => [r.packId, Number(r.count)]));
  return packs.map((p) => ({ ...p, cardCount: countMap.get(p.id) ?? 0 }));
}

export async function getCardPackById(db: DbClient, id: string): Promise<CardPackRow | null> {
  const [row] = await db.select().from(cardPacks).where(eq(cardPacks.id, id)).limit(1);
  return (row as CardPackRow | undefined) ?? null;
}

/** Fetch a single card by id — used for card→pack ownership checks. */
export async function getCardById(db: DbClient, id: string): Promise<CardRow | null> {
  const [row] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
  return (row as CardRow | undefined) ?? null;
}

export async function getCardPackBySlug(
  db: DbClient,
  pluginId: string,
  slug: string
): Promise<CardPackRow | null> {
  const [row] = await db
    .select()
    .from(cardPacks)
    .where(and(eq(cardPacks.pluginId, pluginId), eq(cardPacks.slug, slug)))
    .limit(1);
  return (row as CardPackRow | undefined) ?? null;
}

export async function createCardPack(
  db: DbClient,
  input: CreateCardPackInput
): Promise<CardPackRow> {
  const [row] = await db
    .insert(cardPacks)
    .values({
      pluginId: input.pluginId,
      slug: input.slug,
      name: input.name,
      language: input.language,
      description: input.description ?? null,
      isBuiltIn: input.isBuiltIn ?? false,
    })
    .returning();
  if (!row) throw new Error('createCardPack: insert returned no rows');
  return row as CardPackRow;
}

export async function addCardToPack(
  db: DbClient,
  packId: string,
  ordinal: number,
  payload: Record<string, unknown>,
  difficulty: string = 'easy',
  category: string = 'general'
): Promise<CardRow> {
  const [row] = await db
    .insert(cards)
    .values({ packId, ordinal, payload, difficulty, category })
    .returning();
  if (!row) throw new Error('addCardToPack: insert returned no rows');
  return row as CardRow;
}

export async function listCardsForPack(db: DbClient, packId: string): Promise<CardRow[]> {
  const rows = await db.select().from(cards).where(eq(cards.packId, packId)).orderBy(asc(cards.ordinal));
  return rows as CardRow[];
}

/**
 * List cards for a pack filtered by difficulty tier. Useful when the
 * reducer's draw routine needs to respect a difficulty distribution
 * (60% easy / 30% medium / 10% hard) — pick a tier from the weighted
 * distribution, then sample from the matching subset.
 */
export async function listCardsForPackByDifficulty(
  db: DbClient,
  packId: string,
  difficulty: string
): Promise<CardRow[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.packId, packId), eq(cards.difficulty, difficulty)))
    .orderBy(asc(cards.ordinal));
  return rows as CardRow[];
}

export async function listCardsForPackByCategory(
  db: DbClient,
  packId: string,
  category: string
): Promise<CardRow[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.packId, packId), eq(cards.category, category)))
    .orderBy(asc(cards.ordinal));
  return rows as CardRow[];
}

export async function deleteCardPack(db: DbClient, id: string): Promise<boolean> {
  const rows = await db.delete(cardPacks).where(eq(cardPacks.id, id)).returning({ id: cardPacks.id });
  return rows.length > 0;
}

/** Delete a single card from a pack (admin card management). */
export async function deleteCardFromPack(db: DbClient, cardId: string): Promise<boolean> {
  const rows = await db.delete(cards).where(eq(cards.id, cardId)).returning({ id: cards.id });
  return rows.length > 0;
}

/** Update a card's payload/difficulty/category (admin card management). */
export async function updateCardInPack(
  db: DbClient,
  cardId: string,
  updates: { payload?: Record<string, unknown>; difficulty?: string; category?: string }
): Promise<CardRow | null> {
  const patch: Record<string, unknown> = {};
  if (updates.payload !== undefined) patch.payload = updates.payload;
  if (updates.difficulty !== undefined) patch.difficulty = updates.difficulty;
  if (updates.category !== undefined) patch.category = updates.category;
  if (Object.keys(patch).length === 0) return null;
  const [row] = await db.update(cards).set(patch).where(eq(cards.id, cardId)).returning();
  return (row as CardRow | undefined) ?? null;
}

/**
 * Idempotently seeds a single built-in pack. Skips the insert if a pack
 * with the same `(pluginId, slug)` already exists. Returns the resulting
 * pack row (either the existing one or the freshly inserted one).
 *
 * Backfill behaviour: if the pack already existed before this run, we
 * still walk its cards and make sure each row has a difficulty set. The
 * pre-M20a schema didn't carry `difficulty`, so an old pack inserted
 * by an M18/M19 build will have every card at the column default
 * (`'easy'`). The reducer's `difficultyDistribution` then needs every
 * tier to be representable — so on a re-seed we patch any card whose
 * `difficulty` doesn't match the per-card seed value. Idempotent: rows
 * that already match are left alone.
 */
export async function seedBuiltInPack(
  db: DbClient,
  pluginId: string,
  pack: BuiltInPackSeed
): Promise<{ pack: CardPackRow; inserted: boolean; backfilledCards: number }> {
  const existing = await getCardPackBySlug(db, pluginId, pack.slug);
  if (existing) {
    const backfilled = await backfillPackMetadata(db, existing.id, pack);
    return { pack: existing, inserted: false, backfilledCards: backfilled };
  }
  const created = await createCardPack(db, {
    pluginId,
    slug: pack.slug,
    name: pack.name,
    language: pack.language,
    description: pack.description,
    isBuiltIn: true,
  });
  const defaultDiff = pack.defaultDifficulty ?? 'easy';
  for (let i = 0; i < pack.cards.length; i += 1) {
    const card = pack.cards[i]!;
    const difficulty = card.difficulty ?? defaultDiff;
    await addCardToPack(
      db,
      created.id,
      i,
      { word: card.word, forbiddenWords: card.forbiddenWords },
      difficulty,
      card.category ?? 'general'
    );
  }
  return { pack: created, inserted: true, backfilledCards: 0 };
}

/**
 * Patch the `difficulty` column on an existing pack's cards so each
 * row matches the seed. Called from `seedBuiltInPack` when the pack
 * already existed (idempotent re-seed after a plugin version bump).
 * Returns the number of rows updated.
 *
 * Implementation note: we walk ordinal-by-ordinal rather than relying
 * on a single UPDATE so a re-seed that added or removed cards stays
 * consistent. For a 24-card MVP pack the cost is negligible.
 */
async function backfillPackMetadata(
  db: DbClient,
  packId: string,
  pack: BuiltInPackSeed
): Promise<number> {
  const existing = await listCardsForPack(db, packId);
  const defaultDiff = pack.defaultDifficulty ?? 'easy';
  let updated = 0;
  for (let i = 0; i < pack.cards.length; i += 1) {
    const seedCard = pack.cards[i]!;
    const targetDifficulty = seedCard.difficulty ?? defaultDiff;
    const targetCategory = seedCard.category ?? 'general';
    const row = existing[i];
    if (!row) break;
    if (row.difficulty !== targetDifficulty || row.category !== targetCategory) {
      await db
        .update(cards)
        .set({ difficulty: targetDifficulty, category: targetCategory })
        .where(eq(cards.id, row.id));
      updated += 1;
    }
  }
  return updated;
}

/**
 * Seeds a list of built-in packs in a single call. Idempotent.
 */
export async function seedBuiltInPacks(
  db: DbClient,
  pluginId: string,
  packs: BuiltInPackSeed[]
): Promise<Array<{ pack: CardPackRow; inserted: boolean; backfilledCards: number }>> {
  const out: Array<{ pack: CardPackRow; inserted: boolean; backfilledCards: number }> = [];
  for (const pack of packs) {
    out.push(await seedBuiltInPack(db, pluginId, pack));
  }
  return out;
}
