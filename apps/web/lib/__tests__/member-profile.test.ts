import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearMemberProfileCacheForTests,
  fetchMemberProfile,
  invalidateMemberProfile,
  isMemberProfileFresh,
  MemberProfileError,
  PROFILE_FRESH_MS,
  readCachedMemberProfile,
} from '@/lib/member-profile';

/**
 * The profile card's per-session cache: one request per (server, user),
 * shared by concurrent callers, skipped once cached, refetched on demand,
 * and a 404 is never cached.
 */

const body = (userId: string) => ({ profile: { userId }, viewerCan: { isSelf: false } });

beforeEach(() => {
  __clearMemberProfileCacheForTests();
});

describe('fetchMemberProfile', () => {
  it('asks the profile route once and serves the cache after that', async () => {
    const fetcher = vi.fn(async () => Response.json(body('u1')));
    const first = await fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch });
    const second = await fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch });
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/servers/s1/members/u1/profile', { credentials: 'same-origin', cache: 'no-store' });
    expect(readCachedMemberProfile('s1', 'u1')).toEqual(first);
    // Another server is another profile.
    expect(readCachedMemberProfile('s2', 'u1')).toBeNull();
  });

  it('concurrent callers share one request', async () => {
    let release: (value: Response) => void = () => {};
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const a = fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch });
    const b = fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch });
    release(Response.json(body('u1')));
    expect(await a).toEqual(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('force and invalidate fetch again', async () => {
    const fetcher = vi.fn(async () => Response.json(body('u1')));
    const options = { fetcher: fetcher as unknown as typeof fetch };
    await fetchMemberProfile('s1', 'u1', options);
    await fetchMemberProfile('s1', 'u1', { ...options, force: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    invalidateMemberProfile('s1', 'u1');
    expect(readCachedMemberProfile('s1', 'u1')).toBeNull();
    await fetchMemberProfile('s1', 'u1', options);
    expect(fetcher).toHaveBeenCalledTimes(3);
    invalidateMemberProfile('s1');
    expect(readCachedMemberProfile('s1', 'u1')).toBeNull();
  });

  it('is per viewer: another account signing in on the same tab never reads the last one’s answers', async () => {
    const fetcher = vi.fn(async () => Response.json(body('u1')));
    await fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch, viewerId: 'viewer-a' });
    expect(readCachedMemberProfile('s1', 'u1', 'viewer-a')).not.toBeNull();
    expect(readCachedMemberProfile('s1', 'u1', 'viewer-b')).toBeNull();
    // …and viewer A's answer is gone, not kept for later.
    expect(readCachedMemberProfile('s1', 'u1', 'viewer-a')).toBeNull();
    await fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch, viewerId: 'viewer-b' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('knows when an answer is old enough to ask again', async () => {
    const fetcher = vi.fn(async () => Response.json(body('u1')));
    await fetchMemberProfile('s1', 'u1', { fetcher: fetcher as unknown as typeof fetch });
    expect(isMemberProfileFresh('s1', 'u1')).toBe(true);
    expect(isMemberProfileFresh('s1', 'u1', 0)).toBe(false);
    expect(isMemberProfileFresh('s1', 'nobody')).toBe(false);
    expect(PROFILE_FRESH_MS).toBeGreaterThan(0);
  });

  it('a 404 is null and not cached; another failure throws with its status', async () => {
    const notFound = vi.fn(async () => new Response('{}', { status: 404 }));
    expect(await fetchMemberProfile('s1', 'gone', { fetcher: notFound as unknown as typeof fetch })).toBeNull();
    expect(readCachedMemberProfile('s1', 'gone')).toBeNull();
    const broken = vi.fn(async () => new Response('{}', { status: 500 }));
    await expect(fetchMemberProfile('s1', 'u2', { fetcher: broken as unknown as typeof fetch })).rejects.toBeInstanceOf(MemberProfileError);
  });
});
