// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

/**
 * security-review HUB-003: the listing hides entries without a recent
 * heartbeat (their domain may have expired and changed hands), but the
 * detail page and the leave-site page loaded an entry by id and checked
 * only isListed/isBlocked — a stale entry kept its verified badge and an
 * outbound link there. Both pages now apply the same freshness rule.
 */

const getRegistryInstanceByInstanceId = vi.fn();

vi.mock('@lobbyforge/db', async () => {
  // The freshness rule is the real one; only the row lookup is mocked.
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    getRegistryInstanceByInstanceId,
    HEARTBEAT_STALE_MS: actual.HEARTBEAT_STALE_MS,
    isRegistryInstancePubliclyVisible: actual.isRegistryInstancePubliclyVisible,
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => true }));
vi.mock('@/lib/i18n/server', () => ({
  // Keys stand in for the strings: enough to see what was rendered.
  getTranslator: async () => Object.assign((key: string) => key, { locale: 'en' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

const DOMAIN = 'https://expired.example.com';

function entry(lastHeartbeatAt: Date | null) {
  return {
    id: 'row-1',
    instanceId: '5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11',
    name: 'Old Friends',
    domain: DOMAIN,
    description: null,
    region: null,
    languages: [],
    tags: [],
    features: [],
    isVerified: true,
    isListed: true,
    isBlocked: false,
    nsfw: false,
    onlineUsers: 3,
    publicRoomsCount: 1,
    version: '0.2.0',
    doctorScore: 90,
    lastHeartbeatAt,
    createdAt: new Date(),
    ownerUserId: 'u1',
    publicKey: 'pk',
  };
}

const FRESH = () => new Date(Date.now() - 60_000);
const STALE = () => new Date(Date.now() - 60 * 60_000);

async function renderDetail(): Promise<string> {
  const { default: InstanceDetailPage } = await import('../[instanceId]/page');
  const element = await InstanceDetailPage({ params: Promise.resolve({ instanceId: 'x' }) });
  return renderToStaticMarkup(element as ReactElement);
}

async function renderGo(): Promise<string> {
  const { default: GoPage } = await import('../go/page');
  const element = await GoPage({ searchParams: Promise.resolve({ id: 'x' }) });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  getRegistryInstanceByInstanceId.mockReset();
});

// The first test of each block imports the page module cold; under a full
// parallel run that alone can pass vitest's 5 s default.
describe('/discover/[instanceId] — security-review HUB-003', { timeout: 20_000 }, () => {
  it('shows a fresh listed entry with its badge and the way out', async () => {
    getRegistryInstanceByInstanceId.mockResolvedValue(entry(FRESH()));
    const html = await renderDetail();
    expect(html).toContain('pages.discoverInstance.verified');
    expect(html).toContain('/discover/go?id=');
  });

  it.each([
    ['an old heartbeat', STALE],
    ['no heartbeat at all', () => null],
  ])('is not found for a listed entry with %s', async (_label, at) => {
    getRegistryInstanceByInstanceId.mockResolvedValue(entry(at()));
    await expect(renderDetail()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('/discover/go — security-review HUB-003', { timeout: 20_000 }, () => {
  it('links out to a fresh listed entry', async () => {
    getRegistryInstanceByInstanceId.mockResolvedValue(entry(FRESH()));
    const html = await renderGo();
    expect(html).toContain(`href="${DOMAIN}"`);
    expect(html).toContain('pages.go.verifiedTitle');
  });

  it.each([
    ['an old heartbeat', STALE],
    ['no heartbeat at all', () => null],
  ])('shows the unavailable state, no link and no badge, for %s', async (_label, at) => {
    getRegistryInstanceByInstanceId.mockResolvedValue(entry(at()));
    const html = await renderGo();
    expect(html).toContain('pages.go.unavailableTitle');
    expect(html).not.toContain(DOMAIN);
    expect(html).not.toContain('pages.go.verifiedTitle');
    expect(html).not.toContain('pages.go.continue');
  });
});
