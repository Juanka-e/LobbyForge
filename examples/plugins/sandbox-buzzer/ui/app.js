/**
 * Sandbox Buzzer — frame UI. Plain ES module, no build step, no network.
 *
 * Everything arrives through the frame client:
 *   onInit  → who is looking (viewer), names (players), language, theme
 *   onState → the state PROJECTED for this viewer by server.js projectState:
 *     open round:      { phase: 'open', round, tone, buzzCount, youBuzzed,
 *                        buzzes: null, winner: null, scores }
 *     idle / revealed: { phase, round, tone, buzzCount, youBuzzed,
 *                        buzzes: [{ playerId, ms }], winner, scores }
 * While a round is open nobody's screen knows who buzzed — not even the
 * host's: the order is not hidden by this UI, it is simply not sent.
 *
 * Everything it does is lf.dispatch(action). The host-only buttons are a
 * convenience; the manifest's `host` policies are what enforce them.
 */
import { connect } from './lobbyforge-frame.js';

const STRINGS = {
  en: {
    title: 'Buzzer',
    round: 'Round {n}',
    noRound: 'No round yet',
    phase_idle: 'Waiting',
    phase_open: 'Live',
    phase_revealed: 'Revealed',
    idleHost: 'Open a round when everyone is ready.',
    idlePlayer: 'Waiting for the host to open a round.',
    open: 'Buzz as fast as you can!',
    youBuzzed: 'You buzzed. Waiting for the host to reveal…',
    revealed: 'Round over. The host can open the next one.',
    buzz: 'Buzz!',
    count: { one: '# buzz so far', other: '# buzzes so far' },
    first: '{name} buzzed first',
    nobody: 'Nobody buzzed this round.',
    order: 'Order',
    scores: 'Scores',
    points: { one: '# point', other: '# points' },
    you: '{name} (you)',
    player: 'Player',
    seconds: '{s} s',
    hostControls: 'Host controls',
    openRound: 'Open round',
    nextRound: 'Next round',
    reveal: 'Reveal',
    reset: 'Reset scores',
  },
  tr: {
    title: 'Buzzer',
    round: '{n}. tur',
    noRound: 'Henüz tur yok',
    phase_idle: 'Bekleniyor',
    phase_open: 'Canlı',
    phase_revealed: 'Açıklandı',
    idleHost: 'Herkes hazır olunca bir tur aç.',
    idlePlayer: 'Host bir tur açana kadar bekle.',
    open: 'Olabildiğince hızlı bas!',
    youBuzzed: 'Bastın. Host’un sonucu açıklaması bekleniyor…',
    revealed: 'Tur bitti. Host sonraki turu açabilir.',
    buzz: 'Bas!',
    count: { other: 'Şu ana kadar # basış' },
    first: 'İlk {name} bastı',
    nobody: 'Bu turda kimse basmadı.',
    order: 'Sıra',
    scores: 'Puanlar',
    points: { other: '# puan' },
    you: '{name} (sen)',
    player: 'Oyuncu',
    seconds: '{s} sn',
    hostControls: 'Host kontrolleri',
    openRound: 'Tur aç',
    nextRound: 'Sonraki tur',
    reveal: 'Açıkla',
    reset: 'Puanları sıfırla',
  },
};

let lang = 'en';
let viewer = { userId: '', isHost: false };
let names = new Map();
let current = null;

function pickLanguage(locale) {
  const base = String(locale || '').toLowerCase().split('-')[0];
  return Object.prototype.hasOwnProperty.call(STRINGS, base) ? base : 'en';
}

/** A string, with {name} arguments; plural tables take `count` and fill `#`. */
function t(key, args = {}) {
  const table = STRINGS[lang];
  const entry = table[key] ?? STRINGS.en[key] ?? key;
  if (typeof entry === 'object') {
    const form = new Intl.PluralRules(lang).select(args.count ?? 0);
    const text = entry[form] ?? entry.other;
    return text.replace('#', new Intl.NumberFormat(lang).format(args.count ?? 0));
  }
  return entry.replace(/\{(\w+)\}/g, (_, name) => (name in args ? String(args[name]) : `{${name}}`));
}

function nameOf(userId) {
  const name = names.get(userId) || t('player');
  return userId === viewer.userId ? t('you', { name }) : name;
}

const $ = (id) => document.getElementById(id);

function li(label, value, valueClass) {
  const item = document.createElement('li');
  const who = document.createElement('span');
  who.textContent = label;
  const what = document.createElement('span');
  what.className = valueClass;
  what.textContent = value;
  item.append(who, what);
  return item;
}

function render() {
  const s = current && typeof current === 'object' ? current : {};
  const phase = s.phase === 'open' || s.phase === 'revealed' ? s.phase : 'idle';
  const round = Number.isInteger(s.round) ? s.round : 0;
  const buzzCount = Number.isInteger(s.buzzCount) ? s.buzzCount : 0;
  const buzzes = Array.isArray(s.buzzes) ? s.buzzes : [];

  document.documentElement.lang = lang;
  document.title = t('title');
  $('title').textContent = t('title');
  $('round').textContent = round > 0 ? t('round', { n: round }) : t('noRound');
  const phaseEl = $('phase');
  phaseEl.textContent = t(`phase_${phase}`);
  phaseEl.dataset.phase = phase;

  // Status line: what is happening and what to do next.
  let status;
  if (phase === 'open') status = s.youBuzzed ? t('youBuzzed') : t('open');
  else if (phase === 'revealed') status = t('revealed');
  else status = viewer.isHost ? t('idleHost') : t('idlePlayer');
  $('status').textContent = status;

  // The buzzer: live only while the round is open and you have not buzzed.
  const buzz = $('buzz');
  buzz.textContent = t('buzz');
  buzz.disabled = phase !== 'open' || s.youBuzzed === true;
  buzz.dataset.buzzed = String(s.youBuzzed === true);
  buzz.className = `buzz tone-${typeof s.tone === 'string' ? s.tone : 'amber'}`;
  $('count').textContent = phase === 'idle' ? '' : t('count', { count: buzzCount });

  // After the reveal: who was first, and the whole order with reaction times.
  const result = $('result');
  result.hidden = phase !== 'revealed';
  if (phase === 'revealed') {
    $('winner').textContent = typeof s.winner === 'string' ? t('first', { name: nameOf(s.winner) }) : t('nobody');
    $('order-label').textContent = t('order');
    $('order-label').hidden = buzzes.length === 0;
    const fmt = new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    $('order').replaceChildren(
      ...buzzes.map((b, i) =>
        li(`${i + 1}. ${nameOf(b.playerId)}`, typeof b.ms === 'number' ? t('seconds', { s: fmt.format(b.ms / 1000) }) : '', 'ms')
      )
    );
  }

  // Scores, highest first.
  const scores = s.scores && typeof s.scores === 'object' ? Object.entries(s.scores) : [];
  const ranked = scores.filter(([, n]) => typeof n === 'number' && n > 0).sort((a, b) => b[1] - a[1]);
  $('scores').hidden = ranked.length === 0;
  $('scores-label').textContent = t('scores');
  $('score-list').replaceChildren(...ranked.map(([id, n]) => li(nameOf(id), t('points', { count: n }), 'pts')));

  // Host controls.
  $('host').hidden = !viewer.isHost;
  $('host-label').textContent = t('hostControls');
  const open = $('open');
  open.textContent = round > 0 ? t('nextRound') : t('openRound');
  open.hidden = phase === 'open';
  const reveal = $('reveal');
  reveal.textContent = t('reveal');
  reveal.hidden = phase !== 'open';
  const reset = $('reset');
  reset.textContent = t('reset');
  reset.hidden = round === 0;

  $('app').setAttribute('aria-busy', 'false');
}

const lf = connect({
  onInit(init) {
    lang = pickLanguage(init.locale);
    viewer = init.viewer;
    names = new Map(init.players.map((p) => [p.userId, p.name]));
  },
  onState(state) {
    current = state;
    render();
  },
});

$('buzz').addEventListener('click', () => lf.dispatch({ type: 'buzz' }));
$('open').addEventListener('click', () => lf.dispatch({ type: 'open-round' }));
$('reveal').addEventListener('click', () => lf.dispatch({ type: 'reveal' }));
$('reset').addEventListener('click', () => lf.dispatch({ type: 'reset' }));
