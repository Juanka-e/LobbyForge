import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createCardPack,
  addCardToPack,
  deleteCardFromPack,
  updateCardInPack,
  listCardPackSummaries,
  listCardsForPack,
  getCardPackById,
  getCardById,
  deleteCardPack,
  logAction,
  type CardPackRow,
  type CardRow,
  type DbClient,
} from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { ensureBuiltInContentSeeded } from '@/lib/plugin-content-seeder';
import { readGuestSession } from '@/lib/guest-session';
import { isValidLanguageTag } from '@/lib/language-tag';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * This endpoint manages HUSHLE word packs specifically (NEW-002: the
 * plugin boundary is enforced server-side — `pluginId` is never accepted
 * from the body). A future second card-pack plugin needs its own typed
 * content adapter, not this route.
 */
const PLUGIN_ID = 'hushle';

const LanguageTagSchema = z
  .string()
  .min(2)
  .max(10)
  .refine(isValidLanguageTag, 'Invalid language tag (expected e.g. en, tr, de, pt-BR)');

const DifficultySchema = z.enum(['easy', 'medium', 'hard']);
const ForbiddenWordsSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(10);

/**
 * NEW-001: single discriminated union over `action`. The previous
 * per-action `.strict()` schemas rejected the `action` discriminator
 * itself, so every mutation returned 400.
 */
const AdminCardPackActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create-pack'),
      name: z.string().trim().min(1).max(100),
      language: LanguageTagSchema,
      description: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('duplicate-pack'),
      packId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('add-card'),
      packId: z.string().uuid(),
      word: z.string().trim().min(1).max(100),
      forbiddenWords: ForbiddenWordsSchema,
      difficulty: DifficultySchema,
      category: z.string().trim().min(1).max(60),
    })
    .strict(),
  z
    .object({
      // NEW-003: word and forbiddenWords must arrive TOGETHER — a partial
      // payload update would silently wipe the missing half (the DB
      // helper replaces the whole JSONB payload, it does not merge).
      action: z.literal('update-card'),
      cardId: z.string().uuid(),
      word: z.string().trim().min(1).max(100),
      forbiddenWords: ForbiddenWordsSchema,
      difficulty: DifficultySchema.optional(),
      category: z.string().trim().min(1).max(60).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delete-card'),
      cardId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delete-pack'),
      packId: z.string().uuid(),
    })
    .strict(),
]);

/** Resolve a pack and enforce the hushle plugin boundary (NEW-002). */
async function requireHushlePack(
  db: DbClient,
  packId: string
): Promise<{ ok: true; pack: CardPackRow } | { ok: false; response: NextResponse }> {
  const pack = await getCardPackById(db, packId);
  if (!pack || pack.pluginId !== PLUGIN_ID) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Card pack not found' }, { status: 404 }),
    };
  }
  return { ok: true, pack };
}

/**
 * NEW-004: cards of a built-in pack are immutable (the boot seeder
 * backfills difficulty/category by ordinal — edits and deletions would
 * be reverted or misaligned on the next boot). Duplicate to customise.
 */
function builtInImmutable(pack: CardPackRow): NextResponse | null {
  if (!pack.isBuiltIn) return null;
  return NextResponse.json(
    { error: 'Built-in packs are immutable — duplicate the pack to customise it.' },
    { status: 409 }
  );
}

/** Resolve a card → its pack with hushle ownership enforced. */
async function requireHushleCardPack(
  db: DbClient,
  cardId: string
): Promise<{ ok: true; pack: CardPackRow; card: CardRow } | { ok: false; response: NextResponse }> {
  const card = await getCardById(db, cardId);
  if (!card) {
    return { ok: false, response: NextResponse.json({ error: 'Card not found' }, { status: 404 }) };
  }
  const resolved = await requireHushlePack(db, card.packId);
  if (!resolved.ok) return resolved;
  return { ok: true, pack: resolved.pack, card };
}

/**
 * NEW-005: (pack_id, ordinal) has a unique constraint; two concurrent
 * add-card requests can pick the same next ordinal. Retry with a
 * freshly computed ordinal on unique-violation, and surface a clear
 * 409 instead of a generic 500 when the race persists.
 */
async function insertCardWithOrdinalRetry(
  db: DbClient,
  packId: string,
  word: string,
  forbiddenWords: string[],
  difficulty: 'easy' | 'medium' | 'hard',
  category: string,
  attempts = 3
): Promise<{ ok: true; card: CardRow } | { ok: false; conflict: true }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await listCardsForPack(db, packId);
    const ordinal = existing.length > 0 ? Math.max(...existing.map((c) => c.ordinal)) + 1 : 0;
    try {
      const card = await addCardToPack(db, packId, ordinal, { word, forbiddenWords }, difficulty, category);
      return { ok: true, card };
    } catch (err) {
      const message = (err as Error).message ?? '';
      const isUniqueViolation =
        message.includes('cards_pack_id_ordinal_unique') ||
        message.includes('duplicate key value violates unique constraint');
      if (!isUniqueViolation) throw err;
      // Another request claimed this ordinal — recompute and retry.
    }
  }
  return { ok: false, conflict: true };
}

/** Fire-and-forget audit entry for admin card-pack mutations. */
async function audit(
  actorUserId: string | null,
  action: string,
  targetType: 'card_pack' | 'card',
  targetId: string
): Promise<void> {
  await logAction(getDb(), {
    serverId: null,
    actorUserId,
    action,
    targetType,
    targetId,
  }).catch((err) => console.error('[audit] admin card-pack mutation failed:', (err as Error).message));
}

/** Best-effort actor resolution for the audit trail (null for token auth). */
function resolveActorUid(req: Request): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return readGuestSession(req.headers.get('cookie'), secret)?.uid ?? null;
}

function cardView(card: CardRow) {
  return {
    id: card.id,
    word: String(card.payload.word ?? ''),
    forbiddenWords: Array.isArray(card.payload.forbiddenWords)
      ? (card.payload.forbiddenWords as unknown[])
          .filter((w): w is string => typeof w === 'string')
          .join(', ')
      : '',
    difficulty: card.difficulty,
    category: card.category,
    ordinal: card.ordinal,
  };
}

/**
 * GET /api/admin/card-packs — list Hushle card packs with their cards.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  try {
    const db = getDb();
    // Fresh instance: seed the built-in packs on first admin view so the
    // panel is never empty (the member card-packs route does the same).
    await ensureBuiltInContentSeeded(db);
    const packs = await listCardPackSummaries(db, PLUGIN_ID);
    const packsWithCards = await Promise.all(
      packs.map(async (pack) => ({
        id: pack.id,
        pluginId: pack.pluginId,
        slug: pack.slug,
        name: pack.name,
        language: pack.language,
        description: pack.description,
        isBuiltIn: pack.isBuiltIn,
        cardCount: pack.cardCount,
        cards: (await listCardsForPack(db, pack.id)).map(cardView),
      }))
    );
    return NextResponse.json({ packs: packsWithCards }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[admin/card-packs] list failed:', (err as Error).message, (err as Error).stack);
    return NextResponse.json({ error: 'Failed to load card packs' }, { status: 500 });
  }
}

/**
 * POST /api/admin/card-packs — discriminated on the `action` field:
 * create-pack, duplicate-pack, add-card, update-card, delete-card,
 * delete-pack. Built-in packs and their cards are immutable (NEW-004).
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = AdminCardPackActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request: unknown action or invalid fields' },
      { status: 400 }
    );
  }
  const input = parsed.data;
  const actorUid = resolveActorUid(req);

  try {
    const db = getDb();

    if (input.action === 'create-pack') {
      // NEW-006: a non-Latin pack name slugifies to empty — fall back to
      // a language-scoped random slug instead of `-<timestamp>`.
      const nameSlug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const slug =
        nameSlug.length > 0
          ? `${nameSlug}-${randomUUID().slice(0, 8)}`
          : `${PLUGIN_ID}-${input.language.toLowerCase()}-${randomUUID().slice(0, 8)}`;
      const pack = await createCardPack(db, {
        pluginId: PLUGIN_ID,
        slug,
        name: input.name,
        language: input.language.toLowerCase(),
        description: input.description ?? null,
      });
      await audit(actorUid, 'admin.cardpack.create', 'card_pack', pack.id);
      return NextResponse.json({ pack }, { status: 201 });
    }

    if (input.action === 'duplicate-pack') {
      const resolved = await requireHushlePack(db, input.packId);
      if (!resolved.ok) return resolved.response;
      const source = resolved.pack;
      const sourceCards = await listCardsForPack(db, source.id);
      const copy = await createCardPack(db, {
        pluginId: PLUGIN_ID,
        slug: `${PLUGIN_ID}-${source.language}-${randomUUID().slice(0, 8)}`,
        name: `${source.name} (copy)`.slice(0, 100),
        language: source.language,
        description: source.description
          ? `${source.description} — duplicated copy`.slice(0, 500)
          : 'Duplicated copy',
        // A duplicate is ALWAYS custom — never inherit built-in status.
        isBuiltIn: false,
      });
      for (let i = 0; i < sourceCards.length; i += 1) {
        const card = sourceCards[i]!;
        await addCardToPack(db, copy.id, i, card.payload, card.difficulty, card.category);
      }
      await audit(actorUid, 'admin.cardpack.duplicate', 'card_pack', copy.id);
      return NextResponse.json({ pack: copy }, { status: 201 });
    }

    if (input.action === 'add-card') {
      const resolved = await requireHushlePack(db, input.packId);
      if (!resolved.ok) return resolved.response;
      const inserted = await insertCardWithOrdinalRetry(
        db,
        input.packId,
        input.word,
        input.forbiddenWords,
        input.difficulty,
        input.category
      );
      if (!inserted.ok) {
        return NextResponse.json(
          { error: 'Concurrent card edit detected — please retry.' },
          { status: 409 }
        );
      }
      await audit(actorUid, 'admin.card.create', 'card', inserted.card.id);
      return NextResponse.json({ card: cardView(inserted.card) }, { status: 201 });
    }

    if (input.action === 'update-card') {
      // Card → pack → hushle ownership (NEW-002) + built-in immutability.
      const resolved = await requireHushleCardPack(db, input.cardId);
      if (!resolved.ok) return resolved.response;
      const immutable = builtInImmutable(resolved.pack);
      if (immutable) return immutable;
      const card = await updateCardInPack(db, input.cardId, {
        payload: { word: input.word, forbiddenWords: input.forbiddenWords },
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      });
      await audit(actorUid, 'admin.card.update', 'card', input.cardId);
      return NextResponse.json({ card: card ? cardView(card) : null });
    }

    if (input.action === 'delete-card') {
      const resolved = await requireHushleCardPack(db, input.cardId);
      if (!resolved.ok) return resolved.response;
      const immutable = builtInImmutable(resolved.pack);
      if (immutable) return immutable;
      const ok = await deleteCardFromPack(db, input.cardId);
      await audit(actorUid, 'admin.card.delete', 'card', input.cardId);
      return NextResponse.json({ ok });
    }

    // delete-pack
    const resolved = await requireHushlePack(db, input.packId);
    if (!resolved.ok) return resolved.response;
    const immutable = builtInImmutable(resolved.pack);
    if (immutable) return immutable;
    // cards.pack_id has ON DELETE CASCADE — the pack's cards go with it.
    const ok = await deleteCardPack(db, input.packId);
    await audit(actorUid, 'admin.cardpack.delete', 'card_pack', input.packId);
    return NextResponse.json({ ok });
  } catch (err) {
    console.error('[admin/card-packs] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-card-packs-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 8192,
  rateLimit: { identifier: 'admin-card-packs-post', config: { windowMs: 60_000, maxRequests: 30 } },
});
