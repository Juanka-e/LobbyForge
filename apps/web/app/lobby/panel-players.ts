/**
 * The `players` list a plugin panel is given: who is in the game and in
 * the voice channel, with their names.
 *
 * The session roster's name comes from the database and wins; a voice
 * participant's name fills in one the roster lacks and names people who
 * have not acted yet. A name the lobby has not resolved is `null` — never
 * the raw user id, and never the host's "Unknown member" placeholder. The
 * panel has its own wording for an unnamed player and remembers a real
 * name once one arrives; a placeholder would be remembered as the name.
 */

export interface PanelPlayer {
  userId: string;
  name: string | null;
}

export interface RosterEntry {
  userId: string;
  name?: string | null;
}

export interface VoiceEntry {
  identity: string;
  name: string;
  /** False while `name` is only the host's placeholder (see LobbyVoiceProvider). */
  nameKnown?: boolean;
}

export function buildPanelPlayers(roster: readonly RosterEntry[], participants: readonly VoiceEntry[]): PanelPlayer[] {
  const voiceNames = new Map<string, string>();
  for (const p of participants) {
    if (p.nameKnown !== false && p.name && p.name !== p.identity) voiceNames.set(p.identity, p.name);
  }
  const byId = new Map<string, PanelPlayer>();
  for (const p of roster) {
    const name = p.name && p.name !== p.userId ? p.name : null;
    byId.set(p.userId, { userId: p.userId, name: name ?? voiceNames.get(p.userId) ?? null });
  }
  for (const p of participants) {
    if (!byId.has(p.identity)) byId.set(p.identity, { userId: p.identity, name: voiceNames.get(p.identity) ?? null });
  }
  return [...byId.values()];
}
