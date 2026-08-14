/**
 * LF-001: Canonical server-side state projection for activity viewers.
 *
 * This is the SINGLE source of truth for what each viewer is allowed to
 * see. GET, action response, SSE snapshot and SSE events all call this
 * function — no route has its own copy.
 *
 * Rules:
 * - Hushle: the deck (all cards) is NEVER sent to ANY viewer — including
 *   the host. Only card count metadata is included. The currentCard is
 *   visible ONLY to the currentExplainer (the person who must describe
 *   it); everyone else gets null.
 * - Quiz: correctIndex is stripped from every question unless the phase
 *   is 'reveal' or 'ended'.
 */

export function projectActivityState(
  state: unknown,
  pluginId: string,
  viewerUserId?: string
): unknown {
  if (!state || typeof state !== 'object') return state;
  const s = { ...(state as Record<string, unknown>) };

  if (pluginId === 'hushle') {
    const phase = s.phase as string | undefined;

    // P0-A: NEVER send the deck to any viewer. Replace with metadata only.
    if (Array.isArray(s.deck)) {
      const deckLength = (s.deck as unknown[]).length;
      s.deck = undefined; // strip entirely
      s.deckSize = deckLength;
      s.cardsRemaining = deckLength;
    }

    // P0-B: currentCard — null (not a string placeholder) for non-explainer.
    if (phase !== 'ended' && s.currentCard) {
      const explainerId = s.currentExplainerId ?? s.currentExplainer ?? null;
      const isExplainer =
        viewerUserId != null && explainerId != null && String(explainerId) === viewerUserId;
      if (!isExplainer) {
        s.currentCard = null; // type-safe null, not '[hidden]' string
      }
    }
  }

  if (pluginId === 'quiz') {
    const phase = s.phase as string | undefined;
    if (phase !== 'reveal' && phase !== 'ended' && Array.isArray(s.questions)) {
      s.questions = (s.questions as Array<Record<string, unknown>>).map((q) => {
        const safe = { ...q };
        delete safe.correctIndex;
        return safe;
      });
    }
  }

  return s;
}
