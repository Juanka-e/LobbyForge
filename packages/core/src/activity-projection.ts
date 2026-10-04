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
 *   beta-review: `usedCardIds` (stable DB card ids — the LAST entry is
 *   the CURRENT card) is replaced by `usedCardCount` for every viewer.
 * - Quiz: `deck` (every question of the game WITH its answer) is never
 *   sent to any viewer, the host included — viewers get the open question
 *   as `current` (no answer) plus `questionTotal`. `answers` (who picked
 *   what) is never sent either, not even at the reveal: each viewer gets
 *   `answeredCount` and their OWN `myAnswer`; the reveal publishes
 *   per-option counts only (`reveal.counts`). Legacy (pre-v2) sessions:
 *   correctIndex is stripped from `questions` and other players'
 *   `currentAnswers` are hidden until 'reveal' / 'ended'.
 * - Poll (beta-review S11): `ballotBox` (who voted, in vote order) is
 *   replaced by `ballotCount` + the viewer's own `hasVoted`. Diffing
 *   successive revisions of the box against the option counts revealed
 *   who voted for what.
 * - Marketplace (sandbox-v1) plugins, ADR-007: NOT here. Their state is
 *   projected by the plugin's own `projectState` in the plugin worker,
 *   which only the web app can reach. This function has no rule for them
 *   and returns their state unfiltered, so it must never serve one: a
 *   caller that cannot reach the worker (the ws-gateway) checks
 *   `isCoreProjectedPlugin` first and asks the web app for any other id.
 */

/**
 * The official, compiled-in plugins: for these ids `projectActivityState`
 * alone is the complete per-viewer projection (the rules above, or none
 * because their state is public). Every other id — a marketplace plugin,
 * or a plugin a self-hoster compiled in — must be projected by the web app.
 * Keep in step with apps/web/lib/plugin-registry.ts (a web test checks that
 * every id here is compiled in).
 */
export const CORE_PROJECTED_PLUGIN_IDS: readonly string[] = Object.freeze([
  'hushle',
  'quiz',
  'poll',
  'dice-bot',
  'watch-party',
  'vampire-village',
]);

export function isCoreProjectedPlugin(pluginId: string): boolean {
  return CORE_PROJECTED_PLUGIN_IDS.includes(pluginId);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

    // beta-review: usedCardIds hold stable DB card ids and the LAST one
    // is the CURRENT card — a guesser (currentCard: null) could resolve
    // it. Count only, for everyone (after cardsRemaining used the ids).
    if ('usedCardIds' in s) {
      s.usedCardCount = Array.isArray(s.usedCardIds) ? new Set(s.usedCardIds as unknown[]).size : 0;
      delete s.usedCardIds;
    }

    // P0-B: currentCard — null (not a string placeholder) for anyone who
    // is neither the explainer nor an opposing-team player. Authorized
    // viewers keep the card (incl. its id — the BUST double-tap guard
    // keys on it); they already see the word.
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
    const revealed = phase === 'reveal' || phase === 'ended';
    // Legacy (pre-v2) shape — sessions persisted by an older build keep
    // these rules until their next action migrates them.
    if (!revealed && Array.isArray(s.questions)) {
      s.questions = (s.questions as Array<Record<string, unknown>>).map((q) => {
        const safe = { ...q };
        delete safe.correctIndex;
        return safe;
      });
    }
    // beta-review: other players' locked answers stay private until the
    // reveal — otherwise late answerers copy the crowd.
    if (!revealed && isPlainRecord(s.currentAnswers)) {
      const answers = s.currentAnswers;
      s.answeredCount = Object.keys(answers).length;
      s.currentAnswers =
        viewerUserId != null && Object.prototype.hasOwnProperty.call(answers, viewerUserId)
          ? { [viewerUserId]: answers[viewerUserId] }
          : {};
    }

    // v2: the deck is every question of the game WITH its answer. It never
    // leaves the server — not even for the host, who may be playing a pack.
    delete s.deck;
    // v2: who picked what is never published, not even at the reveal (that
    // shows counts per option). Each viewer gets the number of answers and
    // their OWN choice.
    if ('answers' in s) {
      const answers = isPlainRecord(s.answers) ? s.answers : {};
      const own =
        viewerUserId != null && Object.prototype.hasOwnProperty.call(answers, viewerUserId)
          ? answers[viewerUserId]
          : undefined;
      s.answeredCount = Object.keys(answers).length;
      s.myAnswer = isPlainRecord(own) && typeof own.choice === 'number' ? own.choice : null;
      delete s.answers;
    }
    // Defence in depth: while a question is open, nothing public may carry
    // its answer — the reducer never puts it there, this makes sure.
    if (!revealed) {
      if (isPlainRecord(s.current) && 'correctIndex' in s.current) {
        const { correctIndex: _hidden, ...open } = s.current;
        s.current = open;
      }
      if (s.reveal != null) s.reveal = null;
    }
  }

  if (pluginId === 'poll') {
    // beta-review (S11): WHO voted is not public. The ballot box is kept
    // in canonical state (one-vote enforcement) but every viewer gets
    // only the turnout and whether THEY voted.
    const ballotBox = Array.isArray(s.ballotBox) ? (s.ballotBox as unknown[]) : [];
    delete s.ballotBox;
    s.ballotCount = new Set(ballotBox.map(String)).size;
    s.hasVoted = viewerUserId != null && ballotBox.some((id) => String(id) === viewerUserId);
  }

  if (pluginId === 'vampire-village') {
    // Roles, night choices, private results and the pack chat all live
    // under `state.secret`; see projectVampireVillage below.
    projectVampireVillage(s, viewerUserId);
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

/**
 * Vampire Village: every secret lives under `state.secret` — the roles,
 * tonight's choices, private results (the seer's inspections, the
 * doctor's patient…), role resources, the pack chat and the night
 * history. While the game runs the whole block is removed, and the
 * viewer gets only their own slice as `me`:
 *  - their role, their private notes and their resources;
 *  - while alive: their own choice tonight; a living vampire also gets
 *    the pack — fellow vampires, the pack's current bite votes, the chat.
 * The dead and spectators get no pack and no choices (spectators: no
 * `me` at all). A living player's role never rides on a public row; the
 * role of the dead is public by design (`players[].death.role`). Once
 * the game has ended everything is public.
 */
function projectVampireVillage(s: Record<string, unknown>, viewerUserId: string | undefined): void {
  const secret = isPlainRecord(s.secret) ? s.secret : {};
  delete s.secret;
  if (Array.isArray(s.players)) {
    s.players = s.players.map((row) => {
      if (!isPlainRecord(row) || !('role' in row)) return row;
      const { role: _role, ...rest } = row;
      return rest;
    });
  }

  const roles = isPlainRecord(secret.roles) ? secret.roles : {};
  const role =
    viewerUserId != null && Object.prototype.hasOwnProperty.call(roles, viewerUserId) && typeof roles[viewerUserId] === 'string'
      ? (roles[viewerUserId] as string)
      : null;

  if (role === null || viewerUserId == null) {
    s.me = null;
  } else {
    const players = Array.isArray(s.players) ? s.players : [];
    const alive = players.some((p) => isPlainRecord(p) && p.id === viewerUserId && p.alive === true);
    const own = (bag: unknown): unknown =>
      isPlainRecord(bag) && Object.prototype.hasOwnProperty.call(bag, viewerUserId) ? bag[viewerUserId] : undefined;
    const night = isPlainRecord(secret.night) ? secret.night : {};
    const notes = own(secret.notes);
    const resources = own(secret.resources);
    const choice = own(night);

    let pack: Record<string, unknown> | null = null;
    if (alive && role === 'vampire') {
      const members = Object.keys(roles).filter((id) => roles[id] === 'vampire');
      const votes: Record<string, string> = {};
      for (const id of members) {
        const bite = night[id];
        if (isPlainRecord(bite) && bite.kind === 'bite' && typeof bite.targetId === 'string') votes[id] = bite.targetId;
      }
      pack = { members, votes, chat: Array.isArray(secret.packChat) ? secret.packChat : [] };
    }

    s.me = {
      id: viewerUserId,
      role,
      alive,
      notes: Array.isArray(notes) ? notes : [],
      resources: isPlainRecord(resources) ? resources : {},
      choice: alive && isPlainRecord(choice) ? choice : null,
      pack,
    };
  }

  if (s.phase === 'ended') s.secret = secret;
}
