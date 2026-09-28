import type { QuizClientAction, QuizPlayer, QuizViewState } from '../state';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Everything a view needs besides the state, built once per render by the panel. */
export interface QuizUi {
  t: Translate;
  /** The language the panel speaks (`en`, `tr`, …). */
  locale: string;
  /** A number the way the panel's language writes it: 3,240 / 3.240. */
  number: (value: number) => string;
  nameOf: (userId: string) => string;
  /** The viewer's user id. */
  me: string;
  /** The viewer's roster entry, if they ever joined. */
  mePlayer: QuizPlayer | null;
  isHost: boolean;
  /** The session creator — the quiz host. */
  hostId: string | null;
  hostName: string | null;
  dispatch: (action: QuizClientAction) => void;
}

export interface ViewProps {
  state: QuizViewState;
  ui: QuizUi;
}
