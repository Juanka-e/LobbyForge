/**
 * Test harness for Hushle's panel: fixtures, the server's per-viewer
 * projection, and a real DOM to mount the panel in.
 *
 * react-dom and happy-dom are this package's devDependencies: the panel
 * never needs them at runtime (the host renders it), only these tests do.
 */
import { act, type ReactElement } from 'react';
import { hushleReducer } from '../actions';
import { HushlePanel, type HushlePanelCardPack, type HushlePanelProps } from '../renderClient';
import { createHushleInitialState, type HushleAction, type HushleCard, type HushleState } from '../state';
import type { HushleViewState } from '../ui/model';

// ---------------------------------------------------------------------------
// Fixtures — two teams of two, a floater and a spectator
// ---------------------------------------------------------------------------

export const MIRA = 'u-mira-0001';
export const THEO = 'u-theo-0002';
export const KAYA = 'u-kaya-0003';
export const JUNO = 'u-juno-0004';
export const NOVA = 'u-nova-0005';
export const SAM = 'u-sam-00006';

export const PLAYERS = [
  { userId: MIRA, name: 'Mira' },
  { userId: THEO, name: 'Theo' },
  { userId: KAYA, name: 'Kaya' },
  { userId: JUNO, name: 'Juno' },
  { userId: NOVA, name: 'Nova' },
  { userId: SAM, name: 'Sam' },
];

export const LIGHTHOUSE: HushleCard = {
  id: 'card-lighthouse',
  language: 'en',
  word: 'lighthouse',
  forbiddenWords: ['sea', 'light', 'ship', 'tower', 'coast'],
  difficulty: 'medium',
  category: 'places',
};

export const UMBRELLA: HushleCard = {
  id: 'card-umbrella',
  language: 'en',
  word: 'umbrella',
  forbiddenWords: ['rain', 'wet', 'open', 'handle', 'weather'],
  difficulty: 'easy',
  category: 'objects',
};

export const PYRAMID: HushleCard = {
  id: 'card-pyramid',
  language: 'en',
  word: 'pyramid',
  forbiddenWords: ['egypt', 'pharaoh', 'triangle', 'desert', 'tomb'],
  difficulty: 'hard',
  category: 'history',
};

export function testDeck(size = 12): HushleCard[] {
  const cards = [LIGHTHOUSE, UMBRELLA, PYRAMID];
  for (let i = cards.length; i < size; i += 1) {
    cards.push({
      id: `card-${i}`,
      language: 'en',
      word: `word${i}`,
      forbiddenWords: ['a', 'b', 'c'],
      difficulty: i % 3 === 0 ? 'hard' : i % 2 === 0 ? 'medium' : 'easy',
      category: 'general',
    });
  }
  return cards.slice(0, size);
}

export const PACKS: HushlePanelCardPack[] = [
  { id: 'p-en', slug: 'hushle-en-basic', name: 'Hushle — English (Basic)', language: 'en', cardCount: 24, isBuiltIn: true },
  { id: 'p-tr', slug: 'hushle-tr-basic', name: 'Hushle — Türkçe (Temel)', language: 'tr', cardCount: 24, isBuiltIn: true },
  { id: 'p-de', slug: 'party-de', name: 'Partywörter', language: 'de', cardCount: 40, isBuiltIn: false },
];

export function teamSetupState(opts: { floater?: boolean; teams?: boolean } = {}): HushleState {
  let s = createHushleInitialState();
  s = hushleReducer(s, {
    type: 'start-game',
    packId: 'hushle-en-basic',
    language: 'en',
    createdBy: KAYA,
    cardsPerTurn: 3,
    deck: testDeck(),
  });
  if (opts.teams === false) return s;
  return hushleReducer(s, {
    type: 'set-teams',
    teams: [
      { name: 'Ice', playerIds: [MIRA, THEO] },
      { name: 'Amber', playerIds: [KAYA, JUNO] },
    ],
    floaterPlayerId: opts.floater === false ? null : NOVA,
  });
}

/** Ice's first turn, Mira explaining "lighthouse". */
export function playingState(): HushleState {
  const setup = teamSetupState();
  const started = hushleReducer(setup, { type: 'start-turn', teamId: setup.teams[0]!.id, explainerId: MIRA });
  // The draw is random; pin the card so the tests can name it.
  return {
    ...started,
    currentCard: LIGHTHOUSE,
    usedCardIds: [LIGHTHOUSE.id],
  };
}

/**
 * The server's per-viewer projection (packages/core/src/activity-projection.ts),
 * restated for these tests: the deck and the used ids never leave the
 * server — counts do — and the card goes only to the explainer and the
 * players of the OTHER teams.
 */
export function project(state: HushleState, viewerUserId: string): HushleViewState {
  const { deck, usedCardIds, ...rest } = state;
  const used = new Set(usedCardIds).size;
  const view = {
    ...rest,
    deckSize: deck.length,
    cardsRemaining: Math.max(0, deck.length - used),
    usedCardCount: used,
  } as unknown as HushleViewState;
  if (state.phase !== 'ended' && view.currentCard) {
    const isExplainer = state.currentExplainerId === viewerUserId;
    const isOpponent = state.teams.some(
      (team) => team.id !== state.currentTeamId && team.playerIds.includes(viewerUserId)
    );
    if (!isExplainer && !isOpponent) view.currentCard = null;
  }
  return view;
}

// ---------------------------------------------------------------------------
// A DOM to mount the panel in
// ---------------------------------------------------------------------------

type Root = { render: (node: ReactElement) => void; unmount: () => void };

interface Dom {
  document: Document;
  createRoot: (container: Element) => Root;
}

let domPromise: Promise<Dom> | null = null;

async function loadDom(): Promise<Dom> {
  const happy = (await import('happy-dom')) as unknown as {
    Window: new (options?: { url?: string }) => Window & typeof globalThis;
  };
  const win = new happy.Window({ url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    'document',
    'navigator',
    'HTMLElement',
    'HTMLIFrameElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Text',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'InputEvent',
    'FocusEvent',
    'getComputedStyle',
  ]) {
    const value = (win as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globals, key, {
      value: typeof value === 'function' && key === 'getComputedStyle' ? value.bind(win) : value,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(globals, 'window', { value: win, configurable: true, writable: true });
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const client = (await import('react-dom/client')) as unknown as {
    createRoot: (container: Element) => Root;
  };
  return { document: win.document, createRoot: client.createRoot };
}

export function dom(): Promise<Dom> {
  domPromise ??= loadDom();
  return domPromise;
}

export interface Mounted {
  container: HTMLElement;
  /** Every action the panel dispatched, in order. */
  actions: HushleAction[];
  rerender: (props: Partial<HushlePanelProps>) => Promise<void>;
  unmount: () => Promise<void>;
  text: () => string;
  /** The buttons whose accessible name (aria-label, else text) matches. */
  buttons: (name: string | RegExp) => HTMLButtonElement[];
  button: (name: string | RegExp) => HTMLButtonElement;
  click: (element: HTMLElement) => Promise<void>;
  type: (input: HTMLInputElement, value: string) => Promise<void>;
  submit: (form: HTMLFormElement) => Promise<void>;
  input: (label: string) => HTMLInputElement;
}

export function accessibleName(element: Element): string {
  return (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Mount the real panel, the way the host's PluginSurface does, with a recording dispatch. */
export async function mountPanel(props: Partial<HushlePanelProps> & { state: HushleState }): Promise<Mounted> {
  const { document, createRoot } = await dom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const actions: HushleAction[] = [];
  let current: HushlePanelProps = {
    dispatch: (action) => {
      actions.push(action);
    },
    actorUserId: KAYA,
    hostUserId: KAYA,
    players: PLAYERS,
    ...props,
  };
  await act(async () => root.render(<HushlePanel {...current} />));

  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll('button')].filter((button) => {
      const label = accessibleName(button);
      return typeof name === 'string' ? label === name : name.test(label);
    });

  return {
    container,
    actions,
    async rerender(next) {
      current = { ...current, ...next };
      await act(async () => root.render(<HushlePanel {...current} />));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
    text: () => (container.textContent ?? '').replace(/\s+/g, ' '),
    buttons,
    button(name) {
      const found = buttons(name);
      if (found.length !== 1) {
        const all = [...container.querySelectorAll('button')].map(accessibleName);
        throw new Error(`expected one button named ${String(name)}, found ${found.length}: ${JSON.stringify(all)}`);
      }
      return found[0]!;
    },
    async click(element) {
      await act(async () => element.click());
    },
    async type(input, value) {
      await act(async () => {
        // React tracks the input's value; set it through the prototype
        // setter so the change event is not swallowed.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event('input', { bubbles: true }));
      });
    },
    async submit(form) {
      await act(async () => form.requestSubmit());
    },
    input(label) {
      const match = [...container.querySelectorAll('label')].find((element) => element.textContent?.trim() === label);
      const id = match?.getAttribute('for');
      const input = id ? (container.ownerDocument.getElementById(id) as HTMLInputElement | null) : null;
      if (!input) throw new Error(`no input labelled ${label}`);
      return input;
    },
  };
}
