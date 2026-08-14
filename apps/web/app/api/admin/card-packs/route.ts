import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createCardPack,
  deleteCardPack,
  getCardPackById,
  addCardToPack,
  deleteCardFromPack,
  updateCardInPack,
  listCardPackSummaries,
  listCardsForPack,
} from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/card-packs — list all card packs with their cards.
 * Admin-only. Used by the admin panel's Hushle word management page.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  try {
    const db = getDb();
    const url = new URL(req.url);
    const pluginId = url.searchParams.get('pluginId') ?? undefined;
    const packs = await listCardPackSummaries(db, pluginId);

    // Fetch cards for each pack.
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
        cards: (await listCardsForPack(db, pack.id)).map((card) => ({
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
        })),
      }))
    );

    return NextResponse.json(
      { packs: packsWithCards },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load card packs' }, { status: 500 });
  }
}

const CreatePackSchema = z.object({
  name: z.string().min(1).max(100),
  language: z.string().min(2).max(10),
  pluginId: z.string().default('hushle'),
  description: z.string().max(500).optional(),
}).strict();

const AddCardSchema = z.object({
  packId: z.string().uuid(),
  word: z.string().min(1).max(100),
  forbiddenWords: z.array(z.string().min(1).max(100)).min(1).max(10),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('easy'),
  category: z.string().max(60).default('general'),
}).strict();

const UpdateCardSchema = z.object({
  cardId: z.string().uuid(),
  word: z.string().min(1).max(100).optional(),
  forbiddenWords: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  category: z.string().max(60).optional(),
}).strict();

const DeleteCardSchema = z.object({
  cardId: z.string().uuid(),
}).strict();

const DeletePackSchema = z.object({
  packId: z.string().uuid(),
}).strict();

/**
 * POST /api/admin/card-packs — create a pack, add a card, update a card,
 * or delete a card. The `action` field discriminates.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const action = String(body.action ?? '');

  try {
    const db = getDb();

    if (action === 'create-pack') {
      const parsed = CreatePackSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid pack data' }, { status: 400 });
      }
      const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const pack = await createCardPack(db, {
        pluginId: parsed.data.pluginId,
        slug: `${slug}-${Date.now().toString(36)}`,
        name: parsed.data.name,
        language: parsed.data.language,
        description: parsed.data.description ?? null,
      });
      return NextResponse.json({ pack }, { status: 201 });
    }

    if (action === 'add-card') {
      const parsed = AddCardSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid card data' }, { status: 400 });
      }
      // Ordinal = current max + 1 (append to end).
      const existing = await listCardsForPack(db, parsed.data.packId);
      const ordinal = existing.length > 0 ? Math.max(...existing.map((c) => c.ordinal ?? 0)) + 1 : 0;
      const card = await addCardToPack(
        db,
        parsed.data.packId,
        ordinal,
        { word: parsed.data.word, forbiddenWords: parsed.data.forbiddenWords },
        parsed.data.difficulty,
        parsed.data.category
      );
      return NextResponse.json({ card }, { status: 201 });
    }

    if (action === 'update-card') {
      const parsed = UpdateCardSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid update data' }, { status: 400 });
      }
      const payload: Record<string, unknown> = {};
      if (parsed.data.word !== undefined || parsed.data.forbiddenWords !== undefined) {
        if (parsed.data.word !== undefined) payload.word = parsed.data.word;
        if (parsed.data.forbiddenWords !== undefined) payload.forbiddenWords = parsed.data.forbiddenWords;
      }
      const card = await updateCardInPack(db, parsed.data.cardId, {
        ...(Object.keys(payload).length > 0 ? { payload } : {}),
        ...(parsed.data.difficulty !== undefined ? { difficulty: parsed.data.difficulty } : {}),
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
      });
      return NextResponse.json({ card });
    }

    if (action === 'delete-card') {
      const parsed = DeleteCardSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid delete data' }, { status: 400 });
      }
      const ok = await deleteCardFromPack(db, parsed.data.cardId);
      return NextResponse.json({ ok });
    }

    if (action === 'delete-pack') {
      const parsed = DeletePackSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid delete data' }, { status: 400 });
      }
      const pack = await getCardPackById(db, parsed.data.packId);
      if (!pack) {
        return NextResponse.json({ error: 'Card pack not found' }, { status: 404 });
      }
      if (pack.isBuiltIn) {
        // Built-in packs are re-seeded on boot (ensureBuiltInContentSeeded);
        // deleting one from the admin panel would silently resurrect it.
        return NextResponse.json({ error: 'Built-in packs cannot be deleted' }, { status: 409 });
      }
      // cards.card_packs_id has ON DELETE CASCADE — the pack's cards go with it.
      const ok = await deleteCardPack(db, parsed.data.packId);
      return NextResponse.json({ ok });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
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
