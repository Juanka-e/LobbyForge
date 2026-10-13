// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ModerationClient from '../ModerationClient';

/**
 * security-review HUB-003: the moderation API now returns every directory
 * entry with its status; the dashboard says where each one stands.
 */

const render = (ui: ReactElement) => rtlRender(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);

function instance(instanceId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    instanceId,
    name: `Community ${instanceId}`,
    domain: `https://${instanceId}.example.com`,
    isVerified: false,
    isListed: status === 'listed' || status === 'stale',
    isBlocked: status === 'blocked',
    status,
    onlineUsers: 0,
    lastHeartbeatAt: null,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModerationClient — directory entry status', () => {
  it('labels pending, stale, public and blocked entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          pendingPlugins: [],
          reports: [],
          registryInstances: [
            instance('new', 'pending'),
            instance('quiet', 'stale'),
            instance('live', 'listed'),
            instance('bad', 'blocked'),
          ],
        })
      )
    );
    render(<ModerationClient />);
    expect(await screen.findByText('Community new')).toBeInTheDocument();
    expect(screen.getByText('awaiting review')).toBeInTheDocument();
    expect(screen.getByText('no recent heartbeat — hidden')).toBeInTheDocument();
    // ("public" is also the section's icon ligature — match the badge.)
    expect(screen.getByText('public', { selector: 'span.rounded-full' })).toBeInTheDocument();
    expect(screen.getByText('blocked', { selector: 'span.rounded-full' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Community Directory \(4\)/ })).toBeInTheDocument();
  });
});

describe('ModerationClient — reviewing a plugin', () => {
  const pending = (version: string) => ({
    pendingPlugins: [
      { pluginId: 'cool-game', name: 'Cool Game', version, publisher: 'Dev', category: null, summary: null, submittedAt: '2026-10-01T00:00:00.000Z' },
    ],
    reports: [],
    registryInstances: [],
  });

  it('sends the version on screen, and says so when the submission changed in between', async () => {
    const posts: unknown[] = [];
    let listed = '1.0.0';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/marketplace/review') {
          posts.push(JSON.parse(String(init?.body)));
          listed = '1.1.0';
          return Response.json({ error: 'changed', code: 'version_changed', version: '1.1.0' }, { status: 409 });
        }
        return Response.json(pending(listed));
      })
    );
    render(<ModerationClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cool Game was resubmitted as version 1.1.0 while this list was open, so nothing was saved.'
    );
    expect(posts).toEqual([{ pluginId: 'cool-game', decision: 'approved', version: '1.0.0' }]);
    // The list now shows the new version to review.
    expect(await screen.findByText('v1.1.0')).toBeInTheDocument();
  });
});
