// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
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
