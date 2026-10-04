'use client';

import { useEffect, useState } from 'react';

export type ColorScheme = 'light' | 'dark';

/** Light or dark, from the theme class `AppearanceRuntime` keeps on <html> (dim reads as dark). */
export function readColorScheme(root: HTMLElement = document.documentElement): ColorScheme {
  return root.classList.contains('lf-theme-light') ? 'light' : 'dark';
}

/**
 * The page's current colour scheme, following theme switches. External
 * widgets (Turnstile, reCAPTCHA) take a theme only when they render, so a
 * change re-renders them; ALTCHA follows the `--lf-*` variables directly.
 */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>('dark');
  useEffect(() => {
    const root = document.documentElement;
    setScheme(readColorScheme(root));
    const observer = new MutationObserver(() => setScheme(readColorScheme(root)));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return scheme;
}
