import {
  getCardPackById,
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
    language: language === 'tr' ? 'tr' : 'en',
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
  if (typeof packId !== 'string') {
    return { ok: false, status: 400, error: 'A card pack is required' };
  }
  const pack = await getCardPackById(db, packId);
  if (!pack || pack.pluginId !== 'hushle') {
    return { ok: false, status: 404, error: 'Card pack not found' };
  }
  if (pack.language !== 'en' && pack.language !== 'tr') {
    return { ok: false, status: 409, error: 'Card pack language is not supported' };
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
