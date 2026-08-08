import { describe, it, expect, vi } from 'vitest';

const summaries = [
  { id: 'hushle', name: 'Hushle', trustLevel: 'official', version: '0.2.0' },
  { id: 'quiz', name: 'Quiz', trustLevel: 'official', version: '0.1.0' },
];

vi.mock('@/lib/plugin-registry', () => ({
  listPluginSummaries: () => summaries,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

describe('GET /api/plugins', () => {
  it('returns the plugin summaries from the registry', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/plugins'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plugins: typeof summaries };
    expect(json.plugins).toEqual(summaries);
  });

  it('responds with Cache-Control: no-store', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/plugins'), {});
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
