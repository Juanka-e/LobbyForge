'use client';

/**
 * Mounts the desktop deep-link listener (LF-SEC-008 client half).
 *
 * The Tauri shell evals `postMessage({type:'lobbyforge:handoff', url})`
 * into the page when the OS routes a lobbyforge://session/complete link
 * (or a second instance's argv carries it). We validate + consume the
 * one-time code server-side; a successful handoff reloads so the new
 * session cookie applies everywhere.
 */
import { useEffect } from 'react';
import {
  consumeDesktopSessionHandoff,
  parseDesktopSessionHandoff,
} from '@/lib/desktop-handoff';

export default function DesktopHandoffListener() {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || data.type !== 'lobbyforge:handoff' || typeof data.url !== 'string') return;
      const parsed = parseDesktopSessionHandoff(data.url);
      if (!parsed) return; // malformed/foreign message — ignore silently
      void consumeDesktopSessionHandoff(parsed).then((result) => {
        if (result.ok && result.reload) {
          window.location.reload();
        }
        // Failures are transient (expired/replayed code) — nothing to
        // surface inside the normal web UI.
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return null;
}
