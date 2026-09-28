/**
 * YouTube links and the embed URL — pure, shared by the reducer (which
 * validates what arrives from any client) and the panel (which explains
 * a bad link before anything is sent).
 *
 * The accepted forms are deliberately few. A link is turned into an
 * 11-character video id and nothing else from it is ever used, so a
 * lookalike host, a redirect wrapper or a playlist page is simply "not a
 * YouTube video link":
 *
 *   https://www.youtube.com/watch?v=<id>   (also youtube.com, m., music.)
 *   https://youtu.be/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://www.youtube.com/embed/<id>     (also youtube-nocookie.com)
 *
 * `t=` / `start=` (e.g. `?t=90`, `?t=1m30s`) becomes the start position.
 */

import { POSITION_MAX_SEC } from './constants';

/** The ONLY origin the player is loaded from — and the only one the app's CSP lets it frame. */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** Longest pasted link considered at all. */
export const YOUTUBE_URL_MAX_LENGTH = 2048;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const EMBED_ONLY_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);

export interface YouTubeLink {
  videoId: string;
  /** Where the link asks playback to start, in whole seconds (0 when it does not say). */
  startSec: number;
}

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

/**
 * `90`, `90s`, `1m30s`, `1h2m3s` → seconds. Anything else, or a start
 * past the 12-hour limit, means "from the beginning".
 */
export function parseStartSeconds(raw: string | null | undefined): number {
  if (!raw) return 0;
  const value = raw.trim().toLowerCase();
  let seconds: number;
  if (/^\d{1,6}$/.test(value)) {
    seconds = Number(value);
  } else {
    const match = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(value);
    if (!match || (!match[1] && !match[2] && !match[3])) return 0;
    seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return Number.isFinite(seconds) && seconds <= POSITION_MAX_SEC ? seconds : 0;
}

/** The video a pasted link points at, or null when it is not one of the accepted forms. */
export function parseYouTubeUrl(input: unknown): YouTubeLink | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > YOUTUBE_URL_MAX_LENGTH || /\s/.test(text)) return null;
  // People paste "youtu.be/…" or "www.youtube.com/watch?v=…" without a
  // scheme. Anything that already names one (javascript:, data:, a
  // "host:port" lookalike) keeps it — and fails the protocol check below.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    if (segments.length === 1) videoId = segments[0]!;
  } else if (WATCH_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch') {
      videoId = url.searchParams.get('v');
    } else if (segments.length === 2 && (segments[0] === 'shorts' || segments[0] === 'embed')) {
      videoId = segments[1]!;
    }
  } else if (EMBED_ONLY_HOSTS.has(host)) {
    if (segments.length === 2 && segments[0] === 'embed') videoId = segments[1]!;
  }
  if (!isYouTubeVideoId(videoId)) return null;
  return {
    videoId,
    startSec: parseStartSeconds(url.searchParams.get('t') ?? url.searchParams.get('start')),
  };
}

/**
 * The player's address. `enablejsapi` + `origin` turn on the postMessage
 * protocol (and tell the player which origin to talk back to);
 * `playsinline` keeps phones from jumping to fullscreen; `rel=0` keeps
 * the end screen to the same channel.
 */
export function youTubeEmbedUrl(videoId: string, pageOrigin: string): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: pageOrigin,
    playsinline: '1',
    rel: '0',
  });
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

/** A normal YouTube page for the video — "Open on YouTube" when it cannot be embedded. */
export function youTubeWatchUrl(videoId: string, startSec = 0): string {
  const start = startSec > 0 ? `&t=${Math.floor(startSec)}s` : '';
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${start}`;
}

/** A short, recognisable label for a video we have no title for: `youtu.be/<id>`. */
export function youTubeShortLabel(videoId: string): string {
  return `youtu.be/${videoId}`;
}
