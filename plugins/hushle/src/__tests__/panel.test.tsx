import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hushleReducer } from '../actions';
import type { HushleState } from '../state';
import {
  JUNO,
  KAYA,
  LIGHTHOUSE,
  MIRA,
  NOVA,
  PACKS,
  PLAYERS,
  PYRAMID,
  SAM,
  THEO,
  UMBRELLA,
  dom,
  mountPanel,
  playingState,
  project,
  teamSetupState,
  type Mounted,
} from './harness';
import { createHushleInitialState } from '../state';

/**
 * Hushle's panel, rendered for real: every phase, every seat at the table,
 * and the buttons — what each dispatches, and the double-tap guards.
 */

let mounted: Mounted | null = null;
const mount = async (...args: Parameters<typeof mountPanel>) => {
  mounted = await mountPanel(...args);
  return mounted;
};

beforeAll(async () => {
  await dom();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.documentElement.lang = '';
});

const q = (panel: Mounted, selector: string) => panel.container.querySelector(selector);
const qa = (panel: Mounted, selector: string) => [...panel.container.querySelectorAll(selector)];

describe('the shell', () => {
  it('sits in the UI kit shell with Hushle\'s own stylesheet, tagged with its phase', async () => {
    const panel = await mount({ state: createHushleInitialState() });
    const root = q(panel, '.lfui.hushle');
    expect(root?.getAttribute('data-phase')).toBe('lobby');
    // React hoists both sheets into <head>.
    const sheets = [...document.head.querySelectorAll('style')].map((style) => style.textContent ?? '');
    expect(sheets.some((css) => css.includes('--lfui-surface'))).toBe(true);
    expect(sheets.some((css) => css.includes('--hushle-easy') && css.includes('.lf-theme-light .hushle'))).toBe(true);
  });
});

describe('lobby', () => {
  it('lets the host pick a pack and every start-game option, then starts with exactly those', async () => {
    const panel = await mount({ state: createHushleInitialState(), cardPacks: PACKS });
    expect(panel.text()).toContain('Game settings');
    // One tile per pack; the one in the viewer's language is picked.
    const group = q(panel, '[role="group"][aria-label="Word pack"]')!;
    const tiles = [...group.querySelectorAll('button')];
    expect(tiles).toHaveLength(3);
    expect(tiles.map((tile) => tile.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(tiles[2]!.textContent).toContain('German');
    expect(tiles[2]!.textContent).toContain('40 cards');
    expect(tiles[2]!.textContent).toContain('Custom');
    expect(tiles[1]!.querySelector('[lang="tr"]')?.textContent).toBe('Hushle — Türkçe (Temel)');

    await panel.click(tiles[1]!);
    await panel.click(panel.button('45 s'));
    await panel.click(panel.button('10'));
    await panel.click(panel.button('3'));
    await panel.click(panel.button('Harder'));
    expect(panel.text()).toContain('20% easy · 40% medium · 40% hard');
    await panel.click(panel.button('Start Hushle'));

    expect(panel.actions).toEqual([
      {
        type: 'start-game',
        packId: 'hushle-tr-basic',
        language: 'tr',
        turnDurationSeconds: 45,
        cardsPerTurn: 10,
        teamSize: 3,
        difficultyDistribution: { easy: 0.2, medium: 0.4, hard: 0.4 },
        createdBy: KAYA,
      },
    ]);
  });

  it('starts with the reducer defaults when the host changes nothing', async () => {
    const panel = await mount({ state: createHushleInitialState(), cardPacks: PACKS });
    await panel.click(panel.button('Start Hushle'));
    expect(panel.actions).toEqual([
      {
        type: 'start-game',
        packId: 'hushle-en-basic',
        language: 'en',
        turnDurationSeconds: 60,
        cardsPerTurn: 15,
        teamSize: 2,
        difficultyDistribution: { easy: 0.6, medium: 0.3, hard: 0.1 },
        createdBy: KAYA,
      },
    ]);
  });

  it('falls back to the built-in languages when there are no packs', async () => {
    const panel = await mount({ state: createHushleInitialState(), cardPacks: [] });
    expect(q(panel, '[aria-label="Word pack"]')).toBeNull();
    const languages = q(panel, '[role="group"][aria-label="Card language"]')!;
    // Each language in its own name, tagged with its language.
    expect([...languages.querySelectorAll('[lang]')].map((el) => [el.getAttribute('lang'), el.textContent])).toEqual([
      ['en', 'English'],
      ['tr', 'Türkçe'],
    ]);
    await panel.click(panel.button('Türkçe'));
    await panel.click(panel.button('Start Hushle'));
    expect(panel.actions[0]).toMatchObject({ type: 'start-game', packId: 'hushle-tr-basic', language: 'tr' });
  });

  it('shows everyone else how to play while they wait', async () => {
    const panel = await mount({ state: createHushleInitialState(), actorUserId: SAM, cardPacks: PACKS });
    expect(panel.buttons('Start Hushle')).toHaveLength(0);
    expect(q(panel, '[aria-label="Word pack"]')).toBeNull();
    expect(q(panel, '[role="status"]')?.textContent).toContain('Waiting for the host to start the game…');
    expect(panel.text()).toContain('How to play');
    expect(panel.text()).toContain('a bust costs a point');
    expect(panel.text()).not.toContain(SAM);
  });

  it('tells the host the turn timer covers the whole turn', async () => {
    const panel = await mount({ state: createHushleInitialState(), cardPacks: PACKS });
    expect(panel.text()).toContain('For the whole turn: as many cards as the team can get before it runs out.');
  });
});

describe('team setup', () => {
  it('shows the teams, their open seats, the floater and the settings to everyone', async () => {
    const state = teamSetupState();
    const panel = await mount({ state: project(state, SAM), actorUserId: SAM });
    expect(panel.text()).toContain('Team setup');
    expect(panel.text()).toContain('Ice');
    expect(panel.text()).toContain('Amber');
    expect(panel.text()).toContain('2 of 2 players');
    expect(panel.text()).toContain('English · 12 cards');
    expect(panel.text()).toContain('Nova');
    expect(panel.text()).toContain('Floater');
    expect(panel.text()).toContain('60 s');
    expect(panel.text()).toContain('Mixed');
    // Sam is in the room but not seated yet — named, never shown an id.
    expect(panel.text()).toContain('Not on a team yet');
    expect(panel.text()).toContain('Sam(you)');
    expect(panel.text()).not.toContain(SAM);
    expect(q(panel, 'form')).toBeNull();
    expect(panel.buttons(/Start first turn|Split|Shuffle/)).toHaveLength(0);
    expect(q(panel, '[role="status"]')?.textContent).toContain('Waiting for the host to start the first turn…');
  });

  it('starts the first turn with the first team and its first player', async () => {
    const state = teamSetupState();
    const panel = await mount({ state: project(state, KAYA) });
    expect(panel.text()).toContain('Ice goes first, and Mira explains.');
    await panel.click(panel.button('Start first turn'));
    expect(panel.actions).toEqual([{ type: 'start-turn', teamId: state.teams[0]!.id, explainerId: MIRA }]);
  });

  it('cannot start without a team, and offers to split the room', async () => {
    const panel = await mount({ state: project(teamSetupState({ teams: false }), KAYA) });
    expect(panel.button('Start first turn').disabled).toBe(true);
    expect(panel.text()).toContain('Split the room into two teams, or add a team and seat people one by one.');
    expect(panel.button('Split into two teams').disabled).toBe(false);
  });

  it('splits everyone in the room into two teams, the odd one out floating', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const room = [KAYA, MIRA, THEO, JUNO, NOVA].map((userId) => PLAYERS.find((p) => p.userId === userId)!);
      const panel = await mount({ state: project(teamSetupState({ teams: false }), KAYA), players: room });
      await panel.click(panel.button('Split into two teams'));
      expect(panel.actions).toHaveLength(1);
      const action = panel.actions[0] as { type: string; teams: Array<{ name: string; playerIds: string[] }>; floaterPlayerId?: string };
      expect(action.type).toBe('set-teams');
      expect(action.teams.map((team) => team.name)).toEqual(['Ice', 'Amber']);
      expect(action.teams.map((team) => team.playerIds.length)).toEqual([2, 2]);
      expect([...action.teams.flatMap((team) => team.playerIds), action.floaterPlayerId].sort()).toEqual(
        room.map((p) => p.userId).sort()
      );
    } finally {
      random.mockRestore();
    }
  });

  it('reshuffles the room into the teams already named, leaving out who has left', async () => {
    const state = teamSetupState();
    // Nova has left the room; the others are here.
    const room = PLAYERS.filter((p) => p.userId !== NOVA);
    const panel = await mount({ state: project(state, KAYA), players: room });
    await panel.click(panel.button('Shuffle the teams'));
    const action = panel.actions[0] as { teams: Array<{ name: string; playerIds: string[] }>; floaterPlayerId?: string };
    expect(action.teams.map((team) => team.name)).toEqual(['Ice', 'Amber']);
    const placed = [...action.teams.flatMap((team) => team.playerIds), action.floaterPlayerId].filter(Boolean);
    expect(placed).not.toContain(NOVA);
    expect(placed.sort()).toEqual(room.map((p) => p.userId).sort());
  });

  it('adds an empty team from the form, keeping the teams and the floater already set', async () => {
    const state = teamSetupState();
    const panel = await mount({ state: project(state, KAYA) });
    const add = panel.button('Add team');
    expect(add.disabled).toBe(true);
    expect(q(panel, 'form')?.querySelectorAll('input')).toHaveLength(1);
    await panel.type(panel.input('Team name'), 'Moss');
    expect(add.disabled).toBe(false);
    await panel.submit(q(panel, 'form') as HTMLFormElement);
    expect(panel.actions).toEqual([
      {
        type: 'set-teams',
        teams: [
          { name: 'Ice', playerIds: [MIRA, THEO] },
          { name: 'Amber', playerIds: [KAYA, JUNO] },
          { name: 'Moss', playerIds: [] },
        ],
        floaterPlayerId: NOVA,
      },
    ]);
  });

  it('sends the classic payload when there is no floater', async () => {
    const panel = await mount({ state: project(teamSetupState({ teams: false }), KAYA) });
    await panel.type(panel.input('Team name'), 'Ice');
    await panel.click(panel.button('Add team'));
    expect(panel.actions).toEqual([{ type: 'set-teams', teams: [{ name: 'Ice', playerIds: [] }] }]);
  });

  it('seats, unseats and removes through set-teams', async () => {
    const state = teamSetupState();
    const panel = await mount({ state: project(state, KAYA) });
    await panel.click(panel.button('Remove Theo from Ice'));
    await panel.click(panel.button('Remove Amber'));
    await panel.click(panel.button('Remove floater'));
    expect(panel.actions).toEqual([
      {
        type: 'set-teams',
        teams: [
          { name: 'Ice', playerIds: [MIRA] },
          { name: 'Amber', playerIds: [KAYA, JUNO] },
        ],
        floaterPlayerId: NOVA,
      },
      { type: 'set-teams', teams: [{ name: 'Ice', playerIds: [MIRA, THEO] }], floaterPlayerId: NOVA },
      {
        type: 'set-teams',
        teams: [
          { name: 'Ice', playerIds: [MIRA, THEO] },
          { name: 'Amber', playerIds: [KAYA, JUNO] },
        ],
      },
    ]);
  });

  it('seats a person from the room by name on a team with room, or makes them the floater', async () => {
    const state = hushleReducer(teamSetupState({ floater: false }), {
      type: 'set-teams',
      teams: [
        { name: 'Ice', playerIds: [MIRA] },
        { name: 'Amber', playerIds: [KAYA, JUNO] },
      ],
    });
    const panel = await mount({ state: project(state, KAYA) });
    // Amber is full, so only Ice is offered.
    expect(panel.buttons('Add Sam to Amber')).toHaveLength(0);
    await panel.click(panel.button('Add Sam to Ice'));
    await panel.click(panel.button('Make Sam the floater'));
    expect(panel.actions).toEqual([
      {
        type: 'set-teams',
        teams: [
          { name: 'Ice', playerIds: [MIRA, SAM] },
          { name: 'Amber', playerIds: [KAYA, JUNO] },
        ],
      },
      {
        type: 'set-teams',
        teams: [
          { name: 'Ice', playerIds: [MIRA] },
          { name: 'Amber', playerIds: [KAYA, JUNO] },
        ],
        floaterPlayerId: SAM,
      },
    ]);
  });

  it('only offers seats to people who are in the room', async () => {
    const state = hushleReducer(teamSetupState({ floater: false }), {
      type: 'set-teams',
      teams: [
        { name: 'Ice', playerIds: [MIRA] },
        { name: 'Amber', playerIds: [KAYA] },
      ],
    });
    const room = PLAYERS.filter((p) => p.userId !== SAM);
    const panel = await mount({ state: project(state, KAYA), players: room });
    expect(panel.buttons(/^Add Sam to/)).toHaveLength(0);
    expect(panel.buttons('Add Theo to Ice')).toHaveLength(1);
  });

  it('keeps the names of seated players who step out, and never shows an id', async () => {
    const state = teamSetupState();
    const panel = await mount({ state: project(state, KAYA) });
    // Theo leaves the room: his seat keeps his name.
    await panel.rerender({ players: PLAYERS.filter((p) => p.userId !== THEO) });
    expect(panel.text()).toContain('Theo');
    // Someone the panel never had a name for.
    const stranger = await mountPanel({ state: project(state, KAYA), players: [{ userId: KAYA, name: 'Kaya' }] });
    expect(stranger.text()).toContain('Unknown player');
    expect(stranger.text()).not.toContain(MIRA);
    await stranger.unmount();
  });
});

describe('a running turn, seat by seat', () => {
  const state = playingState();
  const view = (viewer: string, hostUserId = KAYA) => mount({ state: project(state, viewer), actorUserId: viewer, hostUserId });

  it('the explainer sees the whole card: word, category, difficulty, forbidden words', async () => {
    const panel = await view(MIRA);
    expect(panel.text()).toContain("You're explaining");
    const card = q(panel, 'article[aria-label="Word card"]')!;
    expect(card).not.toBeNull();
    const word = card.querySelector('.hushle-word')!;
    expect(word.textContent).toBe('lighthouse');
    // The word speaks the PACK's language, whatever the panel's.
    expect(word.getAttribute('lang')).toBe('en');
    const forbidden = card.querySelector('ul')!;
    expect(forbidden.getAttribute('lang')).toBe('en');
    expect([...forbidden.querySelectorAll('li')].map((li) => li.textContent)).toEqual(LIGHTHOUSE.forbiddenWords);
    expect(document.getElementById(forbidden.getAttribute('aria-labelledby')!)?.textContent).toBe("Don't say");
    expect(card.textContent).toContain('Places');
    // Difficulty: named, and told by pips — never colour alone.
    expect(card.textContent).toContain('Medium');
    expect(card.querySelectorAll('[data-pip="on"]')).toHaveLength(2);
    // Not the host, not an opponent: nothing to press.
    expect(panel.buttons(/Got it|Skip|Penalty|BUST/)).toHaveLength(0);
    expect(panel.text()).toContain('The host scores each card.');
  });

  it('the explaining team does not get the card — they listen', async () => {
    const panel = await view(THEO);
    expect(q(panel, 'article[aria-label="Word card"]')).toBeNull();
    expect(panel.text()).not.toContain('lighthouse');
    expect(panel.text()).toContain("You're guessing");
    expect(panel.text()).toContain('Listen to Mira');
    expect(panel.text()).toContain('Shout your guesses in voice.');
    expect(panel.buttons(/BUST/)).toHaveLength(0);
  });

  it('the other team watches the card and can bust — once per card', async () => {
    const panel = await view(JUNO);
    expect(panel.text()).toContain("You're on the other team");
    expect(q(panel, '.hushle-word')?.textContent).toBe('lighthouse');
    const bust = panel.button('BUST! Forbidden word');
    expect(document.getElementById(bust.getAttribute('aria-describedby')!)?.textContent).toContain('press BUST');
    expect(panel.buttons(/Got it|Skip|Penalty/)).toHaveLength(0);

    await panel.click(bust);
    await panel.click(bust);
    // The card id scopes the BUST (a stale one is ignored by the reducer).
    expect(panel.actions).toEqual([{ type: 'bust-forbidden', cardId: state.currentCard!.id }]);
    expect(bust.disabled).toBe(true);

    // The bust rotates the card; a new card re-arms the button.
    const busted = hushleReducer(state, { type: 'bust-forbidden', bustedBy: JUNO, cardId: state.currentCard!.id });
    await panel.rerender({ state: project({ ...busted, currentCard: UMBRELLA }, JUNO) });
    expect(panel.button('BUST! Forbidden word').disabled).toBe(false);
    expect(q(panel, '.hushle-word')?.textContent).toBe('umbrella');
  });

  it('the host scores every card, and a double tap scores once', async () => {
    const panel = await view(SAM, SAM);
    const gotIt = panel.button('Got it');
    await panel.click(gotIt);
    await panel.click(gotIt);
    await panel.click(panel.button('Skip'));
    expect(panel.actions).toEqual([{ type: 'correct-guess' }]);
    expect(gotIt.disabled).toBe(true);

    // The next card unlocks the host's buttons.
    const next = { ...hushleReducer(state, { type: 'correct-guess' }), currentCard: PYRAMID };
    await panel.rerender({ state: project(next, SAM) });
    await panel.click(panel.button('Skip'));
    const afterSkip = { ...hushleReducer(next, { type: 'pass' }), currentCard: UMBRELLA };
    await panel.rerender({ state: project(afterSkip, SAM) });
    await panel.click(panel.button('Penalty'));
    expect(panel.actions).toEqual([{ type: 'correct-guess' }, { type: 'pass' }, { type: 'penalty' }]);
  });

  it('a host on the watching team busts instead of a second penalty button', async () => {
    const panel = await view(KAYA);
    expect(panel.text()).toContain("You're on the other team");
    expect(panel.buttons('Got it')).toHaveLength(1);
    expect(panel.buttons('Skip')).toHaveLength(1);
    expect(panel.buttons('Penalty')).toHaveLength(0);
    await panel.click(panel.button('BUST! Forbidden word'));
    expect(panel.actions).toEqual([{ type: 'bust-forbidden', cardId: state.currentCard!.id }]);
  });

  it('the host keeps the pace: next card, explainer, end turn, end game', async () => {
    const panel = await view(KAYA);
    expect(panel.text()).toContain('Host tools');
    await panel.click(panel.button('Next card'));
    const explainer = q(panel, '[role="group"][aria-label="Explainer"]')!;
    const options = [...explainer.querySelectorAll('button')];
    // Ice's rotation, in order: Mira, the floater's slot, Theo.
    expect(options.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['Mira', 'true'],
      ['Nova', 'false'],
      ['Theo', 'false'],
    ]);
    await panel.click(options[0]!);
    await panel.click(options[2]!);
    await panel.click(panel.button('End turn'));
    await panel.click(panel.button('End game'));
    expect(panel.actions).toEqual([
      { type: 'next-card' },
      { type: 'set-explainer', explainerId: THEO },
      { type: 'end-turn' },
      { type: 'end-game' },
    ]);
  });

  it('a host who plays on the explaining team scores blind', async () => {
    const panel = await view(THEO, THEO);
    expect(q(panel, 'article[aria-label="Word card"]')).toBeNull();
    expect(panel.text()).toContain('Listen to Mira');
    expect(panel.buttons('Got it')).toHaveLength(1);
    expect(panel.buttons(/BUST/)).toHaveLength(0);
  });

  it('a host who does not play sees the table, not the card', async () => {
    const panel = await view(SAM, SAM);
    expect(panel.text()).toContain("You're hosting");
    expect(panel.text()).toContain('Mira is explaining');
    expect(q(panel, 'article[aria-label="Word card"]')).toBeNull();
    expect(panel.buttons('Got it')).toHaveLength(1);
  });

  it('the floater sits this turn out, marked as the floater', async () => {
    const panel = await view(NOVA);
    expect(panel.text()).toContain("You're the floater");
    expect(panel.text()).toContain('Mira is explaining');
    expect(panel.text()).toContain('Only the explainer and the other team can see the card.');
    expect(panel.text()).toContain('NovaFloater(you)');
    expect(panel.buttons(/BUST|Got it/)).toHaveLength(0);
  });

  it('a spectator watches', async () => {
    const panel = await view(SAM);
    expect(panel.text()).toContain("You're watching");
    expect(q(panel, 'article[aria-label="Word card"]')).toBeNull();
    expect(panel.buttons(/BUST|Got it|End turn/)).toHaveLength(0);
  });

  it('shows the turn, the timer, the scores and who does what', async () => {
    const panel = await view(SAM);
    expect(panel.text()).toContain('Turn 1');
    expect(panel.text()).toContain('Hosted by Kaya');
    expect(panel.text()).toContain('11 cards left');
    const timer = q(panel, '[role="timer"]')!;
    expect(timer.getAttribute('aria-label')).toMatch(/^\d+ seconds? left$/);
    const board = q(panel, 'section[aria-label="Scores"]')!;
    expect(board.textContent).toContain('Their turn');
    expect(board.textContent).toContain('0 points');
    expect(board.textContent).toContain('MiraExplaining');
    expect(board.textContent).toContain('TheoGuessing');
    expect(board.textContent).toContain('JunoWatching');
    expect(panel.text()).toContain('Ice guesses');
    expect(panel.text()).toContain('Amber watches the card');
    expect(panel.text()).toContain('Card 1 of 3');
  });

  it('ends the turn\'s scoring when the time is up, and offers the next turn', async () => {
    const started = Date.now() - 120_000;
    const late = {
      ...state,
      timer: {
        ...state.timer,
        startedAt: new Date(started).toISOString(),
        endsAt: new Date(started + state.timer.durationSeconds * 1000).toISOString(),
      },
    };
    const host = await mount({ state: project(late, KAYA), actorUserId: KAYA });
    expect(host.text()).toContain("Time's up");
    expect(host.text()).toContain('Next up: Amber');
    expect(q(host, '[role="timer"]')).toBeNull();
    expect(q(host, 'article[aria-label="Word card"]')).toBeNull();
    expect(host.buttons(/Got it|Skip|Penalty|BUST|Next card|End turn/)).toHaveLength(0);
    await host.click(host.button('Start next turn'));
    expect(host.actions).toEqual([{ type: 'end-turn' }]);
    await host.unmount();

    const player = await mount({ state: project(late, MIRA), actorUserId: MIRA });
    expect(player.text()).toContain("Time's up");
    expect(q(player, '[role="status"]')?.textContent).toContain('Waiting for the host to start the next turn…');
  });

  it('counts every client down to the deadline in state', async () => {
    const soon = Date.now() + 30_000;
    const turn = { ...state, timer: { ...state.timer, endsAt: new Date(soon).toISOString() } };
    const panel = await mount({ state: project(turn, SAM), actorUserId: SAM });
    const label = q(panel, '[role="timer"]')?.getAttribute('aria-label') ?? '';
    const seconds = Number(label.split(' ')[0]);
    expect(seconds).toBeGreaterThanOrEqual(29);
    expect(seconds).toBeLessThanOrEqual(30);
  });
});

describe('this turn', () => {
  it('lists each card and what became of it, words only for those who saw them', async () => {
    const s0 = playingState();
    const s1 = { ...hushleReducer(s0, { type: 'correct-guess' }), currentCard: UMBRELLA };
    const s2 = { ...hushleReducer(s1, { type: 'bust-forbidden', bustedBy: JUNO, cardId: s1.currentCard!.id }), currentCard: PYRAMID };

    const opponent = await mount({ state: project(s0, JUNO), actorUserId: JUNO });
    expect(opponent.text()).toContain('No cards played yet this turn.');
    await opponent.rerender({ state: project(s1, JUNO) });
    await opponent.rerender({ state: project(s2, JUNO) });
    const chips = qa(opponent, 'li').filter((li) => li.textContent?.includes('·'));
    expect(chips.map((li) => li.textContent)).toEqual(['lighthouse·Got it', 'umbrella·Bust']);
    expect(chips[0]!.querySelector('[lang="en"]')?.textContent).toBe('lighthouse');
    expect(opponent.text()).toContain('Card 3 of 3');
    await opponent.unmount();

    const guesser = await mount({ state: project(s0, THEO), actorUserId: THEO });
    await guesser.rerender({ state: project(s1, THEO) });
    await guesser.rerender({ state: project(s2, THEO) });
    expect(guesser.text()).toContain('Got it');
    expect(guesser.text()).toContain('Bust');
    expect(guesser.text()).not.toContain('lighthouse');
    expect(guesser.text()).not.toContain('umbrella');
  });
});

describe('between turns', () => {
  /** Ice has played its three cards; the turn is over. */
  const betweenTurns = (): HushleState => {
    let s = playingState();
    for (let i = 0; i < 3; i += 1) s = hushleReducer(s, { type: 'correct-guess' });
    return s;
  };

  it('says who goes next, and gives the host the way on', async () => {
    const state = betweenTurns();
    expect(state.phase).toBe('playing');
    const panel = await mount({ state: project(state, KAYA) });
    expect(panel.text()).toContain('Turn over');
    expect(panel.text()).toContain('Next up: Amber');
    // The rotation's pick for Amber (see nextTurnPreview).
    expect(panel.text()).toContain('Kaya explains next.');
    expect(q(panel, '[role="timer"]')).toBeNull();
    expect(panel.buttons(/Got it|BUST/)).toHaveLength(0);
    await panel.click(panel.button('Start next turn'));
    expect(panel.actions).toEqual([{ type: 'end-turn' }]);
  });

  it('keeps the players waiting for the host', async () => {
    const panel = await mount({ state: project(betweenTurns(), JUNO), actorUserId: JUNO });
    expect(q(panel, '[role="status"]')?.textContent).toContain('Waiting for the host to start the next turn…');
    expect(panel.buttons('Start next turn')).toHaveLength(0);
  });

  it('stops at an empty deck', async () => {
    const state = { ...betweenTurns() };
    state.usedCardIds = state.deck.map((card) => card.id);
    const panel = await mount({ state: project(state, KAYA) });
    expect(panel.text()).toContain('The deck is empty');
    expect(panel.text()).toContain('0 cards left');
    expect(panel.button('Start next turn').disabled).toBe(true);
    await panel.click(panel.button('End game'));
    expect(panel.actions).toEqual([{ type: 'end-game' }]);
  });
});

describe('the end', () => {
  const ended = (ice: number, amber: number, played = 8): HushleState => {
    const s = hushleReducer(playingState(), { type: 'end-game' });
    return {
      ...s,
      totalCardsPlayed: played,
      teams: [
        { ...s.teams[0]!, score: ice, correctCount: 3, passCount: 1, penaltyCount: 1 },
        { ...s.teams[1]!, score: amber, correctCount: 4, passCount: 0, penaltyCount: 1 },
      ],
    };
  };

  it('crowns the winner, lists the final scores and recaps the game', async () => {
    const panel = await mount({ state: project(ended(2, 3), JUNO), actorUserId: JUNO });
    expect(panel.text()).toContain('Game over');
    expect(q(panel, '[role="status"]')?.textContent).toBe('Amber wins!');
    expect(panel.text()).toContain('Final score: 3 points');
    const rows = qa(panel, 'ol[aria-label="Final scores"] li');
    expect(rows.map((row) => row.textContent)).toEqual([
      '1Amber4 guessed · 0 skipped · 1 busted3',
      '2Ice3 guessed · 1 skipped · 1 busted2',
    ]);
    expect(panel.text()).toContain('Cards played8');
    expect(panel.text()).toContain('Guessed7');
    expect(panel.text()).toContain('Busted2');
    expect(panel.buttons('Start new game')).toHaveLength(0);
    expect(panel.text()).toContain('The host can start a new game.');
  });

  it('calls a tie a tie', async () => {
    const panel = await mount({ state: project(ended(2, 2), JUNO), actorUserId: JUNO });
    expect(panel.text()).toContain("It's a tie!");
    expect(panel.text()).toContain('Ice and Amber share the win with 2 points.');
  });

  it('has no winner when no card was played', async () => {
    const panel = await mount({ state: project(ended(0, 0, 0), JUNO), actorUserId: JUNO });
    expect(panel.text()).toContain('No cards were played');
  });

  it('lets the host start again with the same pack and settings', async () => {
    const state = ended(2, 3);
    const panel = await mount({ state: project(state, KAYA) });
    await panel.click(panel.button('Start new game'));
    expect(panel.actions).toEqual([
      {
        type: 'start-game',
        packId: 'hushle-en-basic',
        language: 'en',
        turnDurationSeconds: state.settings.turnDurationSeconds,
        cardsPerTurn: state.settings.cardsPerTurn,
        teamSize: state.settings.teamSize,
        difficultyDistribution: state.settings.difficultyDistribution,
        createdBy: KAYA,
      },
    ]);
  });
});

describe('language', () => {
  it('speaks the viewer\'s language while the card keeps its own', async () => {
    document.documentElement.lang = 'tr';
    const panel = await mount({ state: project(playingState(), MIRA), actorUserId: MIRA });
    expect(panel.text()).toContain('Anlatan sensin');
    expect(panel.text()).toContain('Yasaklı kelimeler');
    expect(panel.text()).toContain('Orta');
    expect(q(panel, '.hushle-word')?.getAttribute('lang')).toBe('en');
    expect(panel.text()).not.toMatch(/hushle\.[a-z]/);
  });

  it('never shows a raw key, in any phase or seat', async () => {
    const setup = teamSetupState();
    const playing = playingState();
    const over = hushleReducer(playing, { type: 'end-game' });
    for (const lang of ['en', 'tr']) {
      document.documentElement.lang = lang;
      for (const [state, viewer, host] of [
        [createHushleInitialState(), KAYA, KAYA],
        [createHushleInitialState(), SAM, KAYA],
        [setup, KAYA, KAYA],
        [setup, SAM, KAYA],
        [playing, MIRA, KAYA],
        [playing, THEO, THEO],
        [playing, JUNO, KAYA],
        [playing, NOVA, KAYA],
        [playing, SAM, SAM],
        [over, KAYA, KAYA],
      ] as const) {
        const panel = await mountPanel({ state: project(state, viewer), actorUserId: viewer, hostUserId: host, players: PLAYERS });
        expect(panel.text(), `${lang} ${state.phase} as ${viewer}`).not.toMatch(/hushle\.[a-zA-Z]/);
        await panel.unmount();
      }
    }
  });
});
