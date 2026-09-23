'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { detectLocale } from '@lobbyforge/plugin-sdk';

/**
 * Mounts a plugin's client surface in its OWN component instance.
 *
 * Two beta-review defects live here, which is why this is a component
 * and not an inline call:
 *
 *  1. Hooks. `renderClient` used to be invoked inside the activity
 *     panel's render body, so a panel that calls useState/useEffect
 *     borrowed the CALLER's hook list. The call is conditional (it needs
 *     loaded state), so the hook count changed between renders and React
 *     threw #310, taking the whole voice room down to its error
 *     boundary. Rendering `<PluginSurface>` gives the plugin its own
 *     instance and its own hooks.
 *
 *  2. The "no UI" signal. The SDK lets a plugin return `null` from
 *     `renderClient` (Poll and Dice Bot do), and the room falls back to
 *     the generic state + action surface. Once the call moved behind a
 *     component, the caller only ever saw a truthy element, so that
 *     fallback silently stopped firing and those plugins rendered an
 *     empty panel. The decision therefore has to happen HERE, where the
 *     plugin's actual return value is visible.
 */
export function PluginSurface({
  render,
  props,
  fallback,
}: {
  render: (props: unknown) => ReactNode;
  props: Record<string, unknown>;
  /** Shown when the plugin ships no client UI (`renderClient` → null). */
  fallback: ReactNode;
}) {
  const ui = render(props);
  // Tag the plugin's own subtree with the language it renders in. The
  // host chrome is English, so `<html lang>` stays English — but this
  // content really is Turkish (or whatever the user picked), and saying
  // so here is what gets casing, hyphenation and screen readers right
  // without leaking Turkish casing rules onto English labels.
  const lang = usePluginLocale();
  return <div lang={lang}>{ui ?? fallback}</div>;
}

/**
 * The plugin language, read after mount. It lives on the document (the
 * host publishes it), so it is not knowable during a server render —
 * starting at the default and correcting on mount keeps SSR and the
 * first client paint identical.
 */
function usePluginLocale(): string {
  const [locale, setLocale] = useState('en');
  useEffect(() => {
    setLocale(detectLocale('en'));
  }, []);
  return locale;
}
