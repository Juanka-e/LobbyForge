import {
  getCardPackById,
  getCardPackBySlug,
  listCardsForPack,
  listServerLocalCards,
  type DbClient,
} from '@lobbyforge/db';

type PreparedAction =
  | { ok: true; action: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 409; error: string };

const HUSHLE_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function cardPayload(
  id: string,
  language: string,
  payload: Record<string, unknown>,
  difficulty: string,
  category: string | null
): Record<string, unknown> | null {
  const word = payload.word;
  const forbiddenWords = payload.forbiddenWords;
  if (typeof word !== 'string' || word.trim().length === 0) return null;
  if (!Array.isArray(forbiddenWords) || !forbiddenWords.every((value) => typeof value === 'string')) {
    return null;
  }
  return {
    id,
    // M20b: pass the pack's language through verbatim — hosts can seed
    // packs in any language via the admin panel, not just en/tr.
    language,
    word,
    forbiddenWords,
    difficulty: HUSHLE_DIFFICULTIES.has(difficulty) ? difficulty : 'easy',
    category: category || 'general',
  };
}

/** Hydrate host-owned action fields that must never be trusted from clients. */
export async function preparePluginAction(
  db: DbClient,
  input: { pluginId: string; serverId: string; action: Record<string, unknown> }
): Promise<PreparedAction> {
  if (input.pluginId !== 'hushle' || input.action.type !== 'start-game') {
    return { ok: true, action: input.action };
  }

  const packId = input.action.packId;
  if (typeof packId !== 'string' || packId.length === 0) {
    return { ok: false, status: 400, error: 'A card pack is required' };
  }
  // The host UI sends the pack's SLUG from the pack selector (e.g.
  // `hushle-en-basic`); the admin panel and older sessions may carry the
  // pack's UUID. Accept both so a session can always be (re)started.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pack = UUID_RE.test(packId)
    ? await getCardPackById(db, packId)
    : await getCardPackBySlug(db, 'hushle', packId);
  if (!pack || pack.pluginId !== 'hushle') {
    return { ok: false, status: 404, error: 'Card pack not found' };
  }
  // M20b: accept any well-formed language tag (BCP-47-ish, e.g. `de`,
  // `pt-BR`). The built-in seeds only ship en/tr, but hosts can create
  // packs in their own language through the admin panel.
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(pack.language)) {
    return { ok: false, status: 409, error: 'Card pack language is malformed' };
  }

  const [globalCards, localCards] = await Promise.all([
    listCardsForPack(db, pack.id),
    listServerLocalCards(db, input.serverId, 'hushle'),
  ]);
  const deck = [
    ...globalCards.map((card) =>
      cardPayload(card.id, pack.language, card.payload, card.difficulty, card.category)
    ),
    ...localCards.map((card) =>
      cardPayload(card.id, pack.language, card.payload, card.difficulty, card.category)
    ),
  ].filter((card): card is Record<string, unknown> => card !== null);

  if (deck.length === 0) {
    return { ok: false, status: 409, error: 'Card pack has no playable cards' };
  }
  return {
    ok: true,
    action: { ...input.action, language: pack.language, deck },
  };
}
