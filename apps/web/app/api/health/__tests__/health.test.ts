import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

async function loadRoute() {
  return import('../route.js');
}

describe('GET /api/health', () => {
  it('returns ok=true with a 200 status when the web service is up', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/health'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('responds with Cache-Control: no-store', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/health'), {});
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
