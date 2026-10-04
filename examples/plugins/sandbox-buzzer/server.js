/**
 * Sandbox Buzzer — the example marketplace plugin (sdk "sandbox-v1",
 * ADR-007). Plain JavaScript with no imports: the plugin worker runs this
 * file in a QuickJS VM that has no Node APIs, no network and no timers.
 *
 * The game: the host opens a round, everyone races to buzz, the host
 * reveals who was first and that player scores a point.
 *
 *   open-round  host    start a round (a random colour tone, a clean board)
 *   buzz        member  join the race; the host fills in `playerId`
 *                       (manifest: actorFields ["playerId"]) and the buzzer
 *                       joins the activity's roster (joinsRoster)
 *   reveal      host    end the round and publish the order
 *   reset       host    clear the round and the scores
 *
 * Hidden information: while a round is open, nobody — the host included —
 * learns who buzzed or in which order. `projectState` gives every viewer
 * only the number of buzzes and whether THEY buzzed. The order (with
 * reaction times) becomes public when the host reveals.
 *
 * Contract reminders: every function is synchronous and pure; return the
 * SAME state object to refuse an action (the host then records nothing);
 * use ctx.now and ctx.random(), never Date or Math.random.
 */
'use strict';

var MAX_BUZZES = 50;
var TONES = ['amber', 'teal', 'violet', 'rose', 'lime'];
var ACTIONS = ['open-round', 'buzz', 'reveal', 'reset'];

function freshState() {
  return { v: 1, phase: 'idle', round: 0, tone: null, openedAt: null, buzzes: [], winner: null, scores: {} };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyScores(scores) {
  var out = {};
  if (!isObject(scores)) return out;
  Object.keys(scores).forEach(function (id) {
    if (id !== '__proto__' && typeof scores[id] === 'number' && scores[id] >= 0) out[id] = Math.floor(scores[id]);
  });
  return out;
}

/** Any stored shape → the current one (idempotent). */
function migrate(raw) {
  var s = freshState();
  if (!isObject(raw)) return s;
  if (raw.phase === 'idle' || raw.phase === 'open' || raw.phase === 'revealed') s.phase = raw.phase;
  if (typeof raw.round === 'number' && raw.round >= 0) s.round = Math.floor(raw.round);
  if (typeof raw.tone === 'string' && TONES.indexOf(raw.tone) !== -1) s.tone = raw.tone;
  if (typeof raw.openedAt === 'number') s.openedAt = raw.openedAt;
  if (Array.isArray(raw.buzzes)) {
    s.buzzes = raw.buzzes
      .filter(function (b) {
        return isObject(b) && typeof b.playerId === 'string' && typeof b.at === 'number';
      })
      .slice(0, MAX_BUZZES)
      .map(function (b) {
        return { playerId: b.playerId, at: b.at };
      });
  }
  if (typeof raw.winner === 'string') s.winner = raw.winner;
  s.scores = copyScores(raw.scores);
  return s;
}

function hasBuzzed(state, playerId) {
  return state.buzzes.some(function (b) {
    return b.playerId === playerId;
  });
}

globalThis.plugin = {
  createInitialState: function (_ctx) {
    return freshState();
  },

  validateAction: function (action) {
    if (!isObject(action) || typeof action.type !== 'string') return 'An action needs a type.';
    if (ACTIONS.indexOf(action.type) === -1) return 'Unknown action: ' + action.type.slice(0, 40);
    if (action.type === 'buzz' && typeof action.playerId !== 'string') return 'A buzz needs a player.';
    return null;
  },

  handleAction: function (ctx, state, action) {
    switch (action.type) {
      case 'open-round':
        if (state.phase === 'open') return state;
        return Object.assign({}, state, {
          phase: 'open',
          round: state.round + 1,
          tone: TONES[Math.floor(ctx.random() * TONES.length)],
          openedAt: ctx.now,
          buzzes: [],
          winner: null,
        });
      case 'buzz':
        if (state.phase !== 'open' || typeof action.playerId !== 'string' || action.playerId === '') return state;
        if (hasBuzzed(state, action.playerId) || state.buzzes.length >= MAX_BUZZES) return state;
        return Object.assign({}, state, {
          buzzes: state.buzzes.concat([{ playerId: action.playerId, at: ctx.now }]),
        });
      case 'reveal': {
        if (state.phase !== 'open') return state;
        var winner = state.buzzes.length > 0 ? state.buzzes[0].playerId : null;
        var scores = copyScores(state.scores);
        if (winner) scores[winner] = (scores[winner] || 0) + 1;
        return Object.assign({}, state, { phase: 'revealed', winner: winner, scores: scores });
      }
      case 'reset':
        return freshState();
      default:
        return state;
    }
  },

  projectState: function (state, viewerId, _ctx) {
    var you = typeof viewerId === 'string' && hasBuzzed(state, viewerId);
    if (state.phase !== 'open') {
      // Revealed (or idle): the order and reaction times are public.
      return Object.assign({}, state, {
        buzzCount: state.buzzes.length,
        youBuzzed: you,
        buzzes: state.buzzes.map(function (b) {
          return { playerId: b.playerId, ms: state.openedAt === null ? null : Math.max(0, b.at - state.openedAt) };
        }),
      });
    }
    // Open: no names, no order, no timestamps — for every viewer.
    return {
      v: state.v,
      phase: state.phase,
      round: state.round,
      tone: state.tone,
      openedAt: state.openedAt,
      buzzCount: state.buzzes.length,
      youBuzzed: you,
      buzzes: null,
      winner: null,
      scores: state.scores,
    };
  },

  migrateState: function (raw) {
    return migrate(raw);
  },
};
