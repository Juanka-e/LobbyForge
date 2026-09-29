import { describe, expect, it } from 'vitest';
import {
  YOUTUBE_EMBED_ORIGIN,
  isYouTubeVideoId,
  parseStartSeconds,
  parseYouTubeUrl,
  youTubeEmbedUrl,
  youTubeShortLabel,
  youTubeWatchUrl,
} from '../youtube';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl — the accepted forms', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}`],
    [`http://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?feature=share&v=${ID}&list=PL123`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}/`],
    [`https://youtu.be/${ID}?si=abcdef`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://youtube.com/shorts/${ID}?feature=share`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://youtube-nocookie.com/embed/${ID}?start=10`],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`],
  ])('%s', (url) => {
    expect(parseYouTubeUrl(url)?.videoId).toBe(ID);
  });

  it('accepts a pasted link without a scheme', () => {
    expect(parseYouTubeUrl(`youtu.be/${ID}`)?.videoId).toBe(ID);
    expect(parseYouTubeUrl(`www.youtube.com/watch?v=${ID}`)?.videoId).toBe(ID);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseYouTubeUrl(`  https://youtu.be/${ID}\n`)?.videoId).toBe(ID);
  });

  it('reads the start time from t= or start=', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=42`)).toEqual({ videoId: ID, startSec: 42 });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)?.startSec).toBe(90);
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}?start=15`)?.startSec).toBe(15);
    expect(parseYouTubeUrl(`https://youtu.be/${ID}`)?.startSec).toBe(0);
  });
});

describe('parseYouTubeUrl — everything else is rejected', () => {
  it.each([
    ['a bare id', ID],
    ['an id that is too short', 'https://youtu.be/abc'],
    ['an id that is too long', `https://youtu.be/${ID}X`],
    ['an id with a bad character', 'https://youtu.be/dQw4w9WgXc!'],
    ['a watch page without v', 'https://www.youtube.com/watch?list=PL123'],
    ['a playlist page', 'https://www.youtube.com/playlist?list=PL123'],
    ['a channel page', 'https://www.youtube.com/@LobbyForge'],
    ['a live page (not an accepted form)', `https://www.youtube.com/live/${ID}`],
    ['/v/ legacy form', `https://www.youtube.com/v/${ID}`],
    ['shorts with extra path', `https://www.youtube.com/shorts/${ID}/extra`],
    ['a lookalike host', `https://www.youtube.com.evil.example/watch?v=${ID}`],
    ['a subdomain lookalike', `https://youtu.be.evil.example/${ID}`],
    ['another host carrying the path', `https://evil.example/youtu.be/${ID}`],
    ['a redirect wrapper', `https://www.google.com/url?q=https://youtu.be/${ID}`],
    ['nocookie watch page', `https://www.youtube-nocookie.com/watch?v=${ID}`],
    ['a javascript: url', `javascript:alert("https://youtu.be/${ID}")`],
    ['a data: url', `data:text/html,https://youtu.be/${ID}`],
    ['ftp', `ftp://youtu.be/${ID}`],
    ['credentials in the url', `https://user:pass@youtu.be/${ID}`],
    ['an explicit port', `https://youtu.be:8443/${ID}`],
    ['whitespace inside', `https://youtu.be/ ${ID}`],
    ['an empty string', ''],
    ['not a string', 42],
    ['null', null],
    ['something far too long', `https://youtu.be/${ID}?x=${'a'.repeat(3000)}`],
  ])('%s', (_label, input) => {
    expect(parseYouTubeUrl(input)).toBeNull();
  });
});

describe('parseStartSeconds', () => {
  it.each([
    ['90', 90],
    ['90s', 90],
    ['1m', 60],
    ['1m30s', 90],
    ['1h2m3s', 3723],
    ['2h', 7200],
    [' 45 ', 45],
  ])('%s → %i', (raw, seconds) => {
    expect(parseStartSeconds(raw)).toBe(seconds);
  });

  it.each([[null], [undefined], [''], ['abc'], ['-5'], ['1.5'], ['h'], ['99h']])('%s → 0', (raw) => {
    expect(parseStartSeconds(raw)).toBe(0);
  });
});

describe('ids and urls', () => {
  it('knows a video id', () => {
    expect(isYouTubeVideoId(ID)).toBe(true);
    expect(isYouTubeVideoId('a_b-c_d-e_f')).toBe(true);
    expect(isYouTubeVideoId('short')).toBe(false);
    expect(isYouTubeVideoId(undefined)).toBe(false);
  });

  it('builds the privacy-enhanced embed with the JS API on and the page origin', () => {
    const url = new URL(youTubeEmbedUrl(ID, 'http://localhost:19520'));
    expect(url.origin).toBe(YOUTUBE_EMBED_ORIGIN);
    expect(url.pathname).toBe(`/embed/${ID}`);
    expect(url.searchParams.get('enablejsapi')).toBe('1');
    expect(url.searchParams.get('origin')).toBe('http://localhost:19520');
    expect(url.searchParams.get('playsinline')).toBe('1');
    // No autoplay: playback starts only when the room plays.
    expect(url.searchParams.has('autoplay')).toBe(false);
  });

  it('links to the normal YouTube page, with the start time', () => {
    expect(youTubeWatchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(youTubeWatchUrl(ID, 90)).toBe(`https://www.youtube.com/watch?v=${ID}&t=90s`);
    expect(youTubeShortLabel(ID)).toBe(`youtu.be/${ID}`);
  });
});
