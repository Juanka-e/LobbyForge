/**
 * Sandbox Buzzer — the example marketplace plugin (sdk "sandbox-v1",
 * ADR-007). Plain JavaScript with no imports: the plugin worker runs this
 * file in a QuickJS VM that has no Node APIs, no network and no timers.
 *
 * The game: the host opens a round, everyone races to buzz, the host
 * reveals who was first — or the round reveals itself 30 seconds after it
 * opened — and that player scores a point.
 *
 *   open-round   host    start a round (a random colour tone, a clean board)
 *                        and set the auto-reveal timer
 *   buzz         member  join the race; the host fills in `playerId`
 *                        (manifest: actorFields ["playerId"]) and the buzzer
 *                        joins the activity's roster (joinsRoster)
 *   reveal       host    end the round and publish the order
 *   auto-reveal  system  the same, fired by the timer (no client can send it)
 *   reset        host    clear the round and the scores
 *
 * Hidden information: while a round is open, nobody — the host included —
 * learns who buzzed or in which order. `projectState` gives every viewer
 * only the number of buzzes and whether THEY buzzed. The order (with
 * reaction times) becomes public at the reveal.
 *
 * Host effects (docs/PLUGIN_SDK.md "Effects"; manifest `permissions`,
 * approved by the instance owner at install):
 *   timers   open-round returns a `timer.set` effect: 30 s later the host
 *            runs `auto-reveal` (declared `role: "system"`) through this
 *            reducer, with ctx.now = the due time. A manual reveal or a
 *            reset clears it.
 *   storage  the community's fastest reactions (top 5, one per player)
 *            live in the plugin's storage under "best": read from the
 *            ctx.storage snapshot, written with a `storage.set` effect when
 *            a reveal beats a record. The state carries a copy so the UI
 *            can show it.
 *
 * Contract reminders: every function is synchronous and pure; return the
 * SAME state object to refuse an action (the host then records nothing);
 * use ctx.now and ctx.random(), never Date or Math.random.
 */
'use strict';

var MAX_BUZZES = 50;
var AUTO_REVEAL_MS = 30000;
var BEST_SIZE = 5;
var TONES = ['amber', 'teal', 'violet', 'rose', 'lime'];
var ACTIONS = ['open-round', 'buzz', 'reveal', 'auto-reveal', 'reset'];

/** The host-effects envelope: the next state plus what the host should do. */
function withEffects(state, effects) {
  return { __lf: 1, state: state, effects: effects };
}

function freshState(best) {
  return {
    v: 2,
    phase: 'idle',
    round: 0,
    tone: null,
    openedAt: null,
    revealAt: null,
    buzzes: [],
    winner: null,
    scores: {},
    best: best || [],
  };
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

/** The leaderboard, from storage or state: [{ playerId, name, ms }], fastest first. */
function readBest(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(function (e) {
      return isObject(e) && typeof e.playerId === 'string' && typeof e.ms === 'number' && e.ms >= 0;
    })
    .map(function (e) {
      return { playerId: e.playerId, name: typeof e.name === 'string' ? e.name.slice(0, 64) : '', ms: Math.round(e.ms) };
    })
    .sort(function (a, b) {
      return a.ms - b.ms;
    })
    .slice(0, BEST_SIZE);
}

/** The leaderboard with one more reaction time: one entry per player (their best), top 5. */
function withReaction(best, entry) {
  var mine = best.filter(function (e) {
    return e.playerId === entry.playerId;
  })[0];
  if (mine && mine.ms <= entry.ms) return best;
  var others = best.filter(function (e) {
    return e.playerId !== entry.playerId;
  });
  return readBest(others.concat([entry]));
}

function sameBest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Any stored shape → the current one (idempotent). */
function migrate(raw) {
  var s = freshState();
  if (!isObject(raw)) return s;
  if (raw.phase === 'idle' || raw.phase === 'open' || raw.phase === 'revealed') s.phase = raw.phase;
  if (typeof raw.round === 'number' && raw.round >= 0) s.round = Math.floor(raw.round);
  if (typeof raw.tone === 'string' && TONES.indexOf(raw.tone) !== -1) s.tone = raw.tone;
  if (typeof raw.openedAt === 'number') s.openedAt = raw.openedAt;
  if (typeof raw.revealAt === 'number') s.revealAt = raw.revealAt;
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
  s.best = readBest(raw.best);
  return s;
}

function hasBuzzed(state, playerId) {
  return state.buzzes.some(function (b) {
    return b.playerId === playerId;
  });
}

function nameOf(ctx, playerId) {
  var players = Array.isArray(ctx.players) ? ctx.players : [];
  for (var i = 0; i < players.length; i++) {
    if (players[i].id === playerId) return players[i].name;
  }
  return '';
}

/**
 * End the open round: the first buzzer scores, and a record reaction time
 * goes to the community's leaderboard. The board is merged with the
 * storage snapshot, not just the state's copy: another session may have
 * set a record since this one started.
 */
function reveal(ctx, state) {
  var winner = state.buzzes.length > 0 ? state.buzzes[0].playerId : null;
  var scores = copyScores(state.scores);
  if (winner) scores[winner] = (scores[winner] || 0) + 1;
  var stored = readBest(ctx.storage.get('best'));
  var best = stored;
  if (winner && state.openedAt !== null) {
    var ms = Math.max(0, state.buzzes[0].at - state.openedAt);
    best = withReaction(stored, { playerId: winner, name: nameOf(ctx, winner), ms: ms });
  }
  var next = Object.assign({}, state, { phase: 'revealed', revealAt: null, winner: winner, scores: scores, best: best });
  // Clearing a timer that already fired (auto-reveal) is harmless.
  var effects = [{ type: 'timer.clear', id: 'auto-reveal' }];
  if (!sameBest(best, stored)) effects.push({ type: 'storage.set', key: 'best', value: best });
  return withEffects(next, effects);
}

globalThis.plugin = {
  createInitialState: function (ctx) {
    return freshState(readBest(ctx.storage.get('best')));
  },

  validateAction: function (action) {
    if (!isObject(action) || typeof action.type !== 'string') return 'An action needs a type.';
    if (ACTIONS.indexOf(action.type) === -1) return 'Unknown action: ' + action.type.slice(0, 40);
    if (action.type === 'buzz' && typeof action.playerId !== 'string') return 'A buzz needs a player.';
    return null;
  },

  handleAction: function (ctx, state, action) {
    switch (action.type) {
      case 'open-round': {
        if (state.phase === 'open') return state;
        var round = state.round + 1;
        return withEffects(
          Object.assign({}, state, {
            phase: 'open',
            round: round,
            tone: TONES[Math.floor(ctx.random() * TONES.length)],
            openedAt: ctx.now,
            revealAt: ctx.now + AUTO_REVEAL_MS,
            buzzes: [],
            winner: null,
          }),
          // `round` pins the timer to this round: a stale one changes nothing.
          [{ type: 'timer.set', id: 'auto-reveal', afterMs: AUTO_REVEAL_MS, action: { type: 'auto-reveal', round: round } }]
        );
      }
      case 'buzz':
        if (state.phase !== 'open' || typeof action.playerId !== 'string' || action.playerId === '') return state;
        if (hasBuzzed(state, action.playerId) || state.buzzes.length >= MAX_BUZZES) return state;
        return Object.assign({}, state, {
          buzzes: state.buzzes.concat([{ playerId: action.playerId, at: ctx.now }]),
        });
      case 'reveal':
        if (state.phase !== 'open') return state;
        return reveal(ctx, state);
      case 'auto-reveal':
        // Only the host runs this (role "system"), when the timer is due.
        if (state.phase !== 'open' || action.round !== state.round) return state;
        return reveal(ctx, state);
      case 'reset':
        // Scores go; the community's leaderboard stays.
        return withEffects(freshState(readBest(ctx.storage.get('best'))), [{ type: 'timer.clear', id: 'auto-reveal' }]);
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
      revealAt: state.revealAt,
      buzzCount: state.buzzes.length,
      youBuzzed: you,
      buzzes: null,
      winner: null,
      scores: state.scores,
      best: state.best,
    };
  },

  migrateState: function (raw) {
    return migrate(raw);
  },
};
