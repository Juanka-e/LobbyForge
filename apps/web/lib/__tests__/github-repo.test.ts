import { describe, expect, it, vi } from 'vitest';
import {
  LOBBYFORGE_REPO,
  REPO_STATS_REVALIDATE_SECONDS,
  fetchRepoStats,
  formatStarCount,
  parseRepoStats,
} from '../github-repo';

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } });
}

describe('fetchRepoStats', () => {
  it('reads the live star count from the GitHub API', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ stargazers_count: 1234, forks_count: 5 }));
    await expect(fetchRepoStats({ fetchImpl })).resolves.toEqual({ stars: 1234 });
  });

  it('asks the repo endpoint through the data cache, with a timeout and a user agent', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ stargazers_count: 1 }));
    await fetchRepoStats({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Juanka-e/LobbyForge');
    expect(init?.next).toEqual({ revalidate: REPO_STATS_REVALIDATE_SECONDS });
    expect(REPO_STATS_REVALIDATE_SECONDS).toBe(3600);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('user-agent')).toBeTruthy();
  });

  it('renders without a count when GitHub answers with an error (rate limit, outage)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'API rate limit exceeded' }, { status: 403 }));
    await expect(fetchRepoStats({ fetchImpl })).resolves.toBeNull();
  });

  it('renders without a count when the request fails outright', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchRepoStats({ fetchImpl })).resolves.toBeNull();
  });

  it('gives up after the timeout instead of holding the page', async () => {
    // A GitHub that never answers: only the abort signal can end the wait.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const started = Date.now();
    await expect(fetchRepoStats({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 30 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ignores a body it does not understand', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not json</html>', { status: 200 }));
    await expect(fetchRepoStats({ fetchImpl })).resolves.toBeNull();
  });
});

describe('parseRepoStats', () => {
  it('accepts a whole, non-negative count', () => {
    expect(parseRepoStats({ stargazers_count: 0 })).toEqual({ stars: 0 });
    expect(parseRepoStats({ stargazers_count: 42 })).toEqual({ stars: 42 });
  });

  it('rejects anything that is not a real count', () => {
    for (const body of [null, 'x', 42, {}, { stargazers_count: '42' }, { stargazers_count: -1 }, { stargazers_count: 1.5 }, { stargazers_count: Number.NaN }]) {
      expect(parseRepoStats(body)).toBeNull();
    }
  });
});

describe('formatStarCount', () => {
  it('keeps small counts whole', () => {
    expect(formatStarCount(7, 'en')).toBe('7');
    expect(formatStarCount(999, 'en')).toBe('999');
  });

  it('shortens large counts the way the reader writes numbers', () => {
    expect(formatStarCount(1234, 'en')).toBe('1.2K');
    // Turkish uses a decimal comma and its own abbreviation.
    expect(formatStarCount(1234, 'tr')).toMatch(/^1,2\s?B$/);
  });
});

describe('LOBBYFORGE_REPO', () => {
  it('points every hub link at the public repository', () => {
    for (const [key, value] of Object.entries(LOBBYFORGE_REPO)) {
      if (key === 'slug' || key === 'license') continue;
      expect(value, key).toMatch(/^https:\/\/(api\.)?github\.com\/(repos\/)?Juanka-e\/LobbyForge/);
    }
  });
});
