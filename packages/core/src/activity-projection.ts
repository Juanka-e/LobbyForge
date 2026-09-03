/**
 * LF-001: Canonical server-side state projection for activity viewers.
 *
 * SINGLE source of truth, shared by the web app's REST/SSE routes AND
 * the ws-gateway (SEC-001): every path a state blob reaches a viewer
 * goes through this function.
 *
 * Rules:
 * - Hushle: the deck (all cards) is NEVER sent to ANY viewer — including
 *   the host. Only count metadata (deckSize, cardsRemaining = deck minus
 *   used ids) is included. The currentCard is visible to:
 *     1. the currentExplainer (they must describe it), and
 *     2. members of OPPOSING teams (classic Taboo: opponents watch the
 *        card to catch forbidden-word use and press BUST).
 *   Teammates of the explaining team, the floater, the host (when not
 *   playing) and spectators get null.
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
    // cardsRemaining subtracts usedCardIds — deckSize stays the full total.
    if (Array.isArray(s.deck)) {
      const deckLength = (s.deck as unknown[]).length;
      const usedCount = Array.isArray(s.usedCardIds) ? new Set(s.usedCardIds as unknown[]).size : 0;
      delete s.deck;
      s.deckSize = deckLength;
      s.cardsRemaining = Math.max(0, deckLength - usedCount);
    }

    // P0-B: currentCard — null (not a string placeholder) for anyone who
    // is neither the explainer nor an opposing-team player.
    if (phase !== 'ended' && s.currentCard) {
      const explainerId = s.currentExplainerId ?? s.currentExplainer ?? null;
      const isExplainer =
        viewerUserId != null && explainerId != null && String(explainerId) === viewerUserId;
      if (!isExplainer && !isOpposingTeamPlayer(s, viewerUserId)) {
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

/**
 * Classic-Taboo visibility: true when the viewer plays on a team OTHER
 * than the currently explaining team (state.currentTeamId). Teammates
 * of the explainer, floaters (no team) and spectators return false.
 */
function isOpposingTeamPlayer(
  s: Record<string, unknown>,
  viewerUserId: string | undefined
): boolean {
  if (viewerUserId == null) return false;
  const currentTeamId = s.currentTeamId;
  if (currentTeamId == null) return false;
  const teams = Array.isArray(s.teams) ? (s.teams as Array<Record<string, unknown>>) : [];
  return teams.some((team) => {
    if (!team || typeof team !== 'object') return false;
    const teamId = team.id;
    if (teamId == null || String(teamId) === String(currentTeamId)) return false;
    const playerIds = Array.isArray(team.playerIds) ? (team.playerIds as unknown[]) : [];
    return playerIds.some((pid) => String(pid) === viewerUserId);
  });
}
