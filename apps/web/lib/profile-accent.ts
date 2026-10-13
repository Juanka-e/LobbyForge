/**
 * The colour of a profile card's banner band when the member has no banner
 * (docs/PROFILES.md): the avatar's dominant colour, sampled on a small
 * canvas; else the colour of their highest coloured role; else the theme
 * accent.
 *
 * Only same-origin avatars are sampled. A legacy external (https) avatar
 * would taint the canvas — reading its pixels throws — so it goes straight
 * to the fallbacks.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The theme accent — a CSS variable, so it follows dark, dim and light. */
export const THEME_ACCENT_COLOR = 'var(--lf-user-accent, #8FB8FF)';

/** Side of the square the avatar is drawn into before sampling. */
const SAMPLE_SIZE = 24;
/** Pixels more transparent than this are background, not avatar. */
const MIN_ALPHA = 125;

/**
 * The dominant colour of RGBA pixel data: pixels are grouped by their top
 * three bits per channel, the fullest group wins, and its pixels are
 * averaged. Transparent pixels are skipped. Null when nothing is opaque.
 */
export function dominantColor(data: ArrayLike<number>): Rgb | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha < MIN_ALPHA) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best) return null;
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

export function toCssColor({ r, g, b }: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** A path on this origin (`/api/users/…`) — never `//host`, never an absolute URL. */
export function isSameOriginPath(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

const ROLE_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** The highest role's colour that is a valid hex colour, if any (roles come highest first). */
export function roleAccentColor(roles: ReadonlyArray<{ color: string | null }> | null | undefined): string | null {
  for (const role of roles ?? []) {
    if (role.color && ROLE_COLOR_RE.test(role.color)) return role.color;
  }
  return null;
}

/** The band colour: sampled avatar, then role colour, then the theme accent. */
export function bannerBandColor(sampled: string | null, roles: ReadonlyArray<{ color: string | null }> | null | undefined): string {
  return sampled ?? roleAccentColor(roles) ?? THEME_ACCENT_COLOR;
}

const sampled = new Map<string, Promise<string | null>>();

/**
 * Sample a same-origin avatar's dominant colour (cached per URL for the
 * session). Resolves null for anything that cannot be sampled.
 */
export function sampleAvatarColor(url: string | null | undefined): Promise<string | null> {
  if (!isSameOriginPath(url) || typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }
  const known = sampled.get(url);
  if (known) return known;
  const job = new Promise<string | null>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const color = dominantColor(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
        resolve(color ? toCssColor(color) : null);
      } catch {
        // A tainted canvas or a browser without 2D canvas: use the fallbacks.
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
  sampled.set(url, job);
  return job;
}
