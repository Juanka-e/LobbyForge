'use client';

import type { ReactNode } from 'react';
import { pickBestLocale } from '@lobbyforge/plugin-sdk';
import { useLocale } from '@/lib/i18n/client';

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
  pluginId,
  render,
  props,
  fallback,
}: {
  /** Used to work out which of the plugin's languages it will render in. */
  pluginId: string;
  render: (props: unknown) => ReactNode;
  props: Record<string, unknown>;
  /** Shown when the plugin ships no client UI (`renderClient` → null). */
  fallback: ReactNode;
}) {
  const ui = render(props);
  // Tag the subtree with the language the plugin will ACTUALLY speak.
  // That is the app's language when the plugin ships it, and otherwise
  // the plugin's own fallback — an app switched to German still gets a
  // plugin that only knows English and Turkish, and its text is English.
  // Saying so is what gets casing, hyphenation and screen readers right.
  const lang = pickBestLocale(pluginId, useLocale());
  return <div lang={lang}>{ui ?? fallback}</div>;
}
