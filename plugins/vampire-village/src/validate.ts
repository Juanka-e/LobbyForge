/**
 * The outer belt: shape checks the host runs BEFORE dispatch (a returned
 * string is a 400). The activity route only checks `{ type }`, so every
 * other field arrives as raw JSON from any client. The reducer still
 * re-checks everything against the game state — this only keeps garbage
 * out of it.
 */
import { CHAT_MAX_LENGTH, SETTING_LIMITS } from './state';
import type { VillageAction, VillageSettings } from './state';

const MAX_ID_LENGTH = 128;
/** Raw length before tidying; the reducer enforces the real limits. */
const MAX_NAME_INPUT = 64;
const MAX_TEXT_INPUT = CHAT_MAX_LENGTH * 2;
const MAX_EXTEND_SECONDS = 600;

type ActionType = VillageAction['type'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function needsActor(action: Record<string, unknown>): string | null {
  return isId(action.playerId) ? null : `${String(action.type)} requires a playerId.`;
}

function textProblem(action: Record<string, unknown>): string | null {
  const text = action.text;
  if (typeof text !== 'string') return 'text must be a string.';
  if (text.trim().length === 0) return 'text must not be empty.';
  if (text.length > MAX_TEXT_INPUT) return `text must be at most ${CHAT_MAX_LENGTH} characters.`;
  return null;
}

function targetProblem(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  return isId(value) ? null : 'targetId must be a player id' + (nullable ? ' or null.' : '.');
}

const SETTING_KEYS = Object.keys(SETTING_LIMITS) as Array<keyof VillageSettings>;

const VALIDATORS: Record<ActionType, (action: Record<string, unknown>) => string | null> = {
  join: (a) =>
    needsActor(a) ??
    (typeof a.name !== 'string' || a.name.length > MAX_NAME_INPUT
      ? `name must be a string of at most ${MAX_NAME_INPUT} characters.`
      : a.color !== undefined && typeof a.color !== 'string'
        ? 'color must be a string.'
        : null),
  leave: needsActor,
  'set-ready': (a) => needsActor(a) ?? (typeof a.ready === 'boolean' ? null : 'ready must be a boolean.'),
  configure: (a) => {
    if (!isRecord(a.settings)) return 'settings must be an object.';
    for (const key of SETTING_KEYS) {
      const value = a.settings[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        return `${key} must be a number of seconds.`;
      }
    }
    return null;
  },
  start: () => null,
  kick: (a) => (isId(a.targetId) ? null : 'kick requires a targetId.'),
  advance: (a) => (isNonNegativeInt(a.phaseId) ? null : 'advance requires the phaseId it ends.'),
  timeout: (a) => needsActor(a) ?? (isNonNegativeInt(a.phaseId) ? null : 'timeout requires the phaseId it ends.'),
  pause: () => null,
  resume: () => null,
  extend: (a) =>
    typeof a.seconds === 'number' &&
    Number.isInteger(a.seconds) &&
    a.seconds !== 0 &&
    Math.abs(a.seconds) <= MAX_EXTEND_SECONDS
      ? null
      : `seconds must be a whole number between -${MAX_EXTEND_SECONDS} and ${MAX_EXTEND_SECONDS}, not 0.`,
  'night-target': (a) => needsActor(a) ?? ('targetId' in a ? targetProblem(a.targetId, true) : 'targetId is required.'),
  'night-shield': (a) => needsActor(a) ?? (typeof a.raise === 'boolean' ? null : 'raise must be a boolean.'),
  vote: (a) => needsActor(a) ?? ('targetId' in a ? targetProblem(a.targetId, true) : 'targetId is required.'),
  chat: (a) => needsActor(a) ?? textProblem(a),
  'pack-chat': (a) => needsActor(a) ?? textProblem(a),
  'play-again': () => null,
  'end-game': () => null,
};

export function validateVillageAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  const type = action.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(VALIDATORS, type)) {
    return `Unknown action type: ${String(type)}`;
  }
  return VALIDATORS[type as ActionType](action);
}

/** Every action type the plugin understands. */
export const VILLAGE_ACTION_TYPES = Object.keys(VALIDATORS) as ActionType[];
