/**
 * Desktop session-handoff CONSUMER (LF-SEC-008, client half).
 *
 * The desktop shell forwards `lobbyforge://session/complete?code&state`
 * deep links into the page via postMessage ({type:'lobbyforge:handoff'}).
 * This module validates the URL shape and burns the one-time code at
 * /api/auth/desktop-session/complete — ALWAYS sending the state with
 * the code (the server constant-time verifies it; a code alone is
 * worthless). On success the session cookie is set and the caller
 * reloads.
 */

const HANDOFF_CODE = /^[A-Za-z0-9_-]{43,128}$/;
const HANDOFF_STATE = /^[A-Za-z0-9_-]{16,128}$/;

export interface ParsedHandoff {
  code: string;
  state: string;
  instanceUrl: string | null;
}

/** Validate a `lobbyforge://session/complete?code&state[&instance]` URL. */
export function parseDesktopSessionHandoff(input: string): ParsedHandoff | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'lobbyforge:' || url.hostname !== 'session' || url.pathname !== '/complete') {
    return null;
  }
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const instance = url.searchParams.get('instance') ?? '';
  if (!HANDOFF_CODE.test(code)) return null;
  if (!HANDOFF_STATE.test(state)) return null;
  return { code, state, instanceUrl: instance || null };
}

export interface HandoffResult {
  ok: boolean;
  /** Fresh session established — the caller should reload the page. */
  reload: boolean;
  user?: { id: string; displayName: string };
  error?: string;
}

/** Burn the one-time code and establish the session cookie. */
export async function consumeDesktopSessionHandoff(parsed: ParsedHandoff): Promise<HandoffResult> {
  try {
    const res = await fetch('/api/auth/desktop-session/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // LF-SEC-008: the state ALWAYS accompanies the code.
      body: JSON.stringify({ code: parsed.code, state: parsed.state }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, reload: false, error: detail.error ?? `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { user: { id: string; displayName: string } };
    return { ok: true, reload: true, user: body.user };
  } catch (err) {
    return { ok: false, reload: false, error: (err as Error).message };
  }
}
