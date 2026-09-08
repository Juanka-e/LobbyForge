'use client';

/**
 * Mounts the desktop deep-link listener (LF-SEC-008 client half).
 *
 * The Tauri shell injects the handoff by evaluating
 * `window.postMessage({source: window, type:'lobbyforge:handoff', …})`
 * INSIDE this page — so a genuine handoff ALWAYS arrives with
 * event.source === window and event.origin === this page's origin.
 *
 * Binding to those two facts is what makes the listener safe: ANY other
 * window (a malicious site that popped this tab, an iframe, an opener)
 * can postMessage freely but can never make event.source === window.
 * Without this check the listener was a session-swapping vector — an
 * attacker could feed a code+state from THEIR OWN login into the
 * victim's open tab, silently replacing the victim's session with the
 * attacker's.
 *
 * Additional hardening: one consume attempt per page load (a second
 * deep link while a handoff is in flight is ignored), and failures are
 * silent (expired/replayed codes are routine, not user-facing errors).
 */
import { useEffect } from 'react';
import {
  consumeDesktopSessionHandoff,
  parseDesktopSessionHandoff,
} from '@/lib/desktop-handoff';

export default function DesktopHandoffListener() {
  useEffect(() => {
    let consuming = false;
    const onMessage = (event: MessageEvent) => {
      // Device binding: only messages the shell injected INTO THIS page.
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || data.type !== 'lobbyforge:handoff' || typeof data.url !== 'string') return;
      if (consuming) return; // one consume attempt per page load
      const parsed = parseDesktopSessionHandoff(data.url);
      if (!parsed) return; // malformed/foreign message — ignore silently
      consuming = true;
      void consumeDesktopSessionHandoff(parsed).then((result) => {
        if (result.ok && result.reload) {
          window.location.reload();
        }
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return null;
}
