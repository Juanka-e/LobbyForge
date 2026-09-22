'use client';

import type { ReactNode } from 'react';

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
  return <>{ui ?? fallback}</>;
}
