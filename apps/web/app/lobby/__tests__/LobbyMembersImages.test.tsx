// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

/**
 * security-review FILE-001: the members panel renders avatars from short
 * same-origin URLs and builds the banner URL from the list's reference
 * only when a profile popover opens — no image is inlined in the list.
 */

vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ subscribe: () => () => {} }),
}));
vi.mock('../LobbyVoiceProvider', () => ({
  useLobbyVoice: () => ({ getRemoteVolume: () => 1, setRemoteVolume: () => {} }),
}));

const MEMBER = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/presence')) return Response.json({ presences: [] });
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('members panel images', () => {
  it('uses the avatar URL and loads the banner only for the opened profile', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    const { container } = render(
      <I18nProvider {...providerPropsFor('en')}>
        <LobbyMembersClient
          serverId="srv-1"
          initialMembers={[
            {
              id: MEMBER,
              name: 'Alice',
              status: 'online',
              avatarUrl: `/api/users/${MEMBER}/avatar?v=0123456789ab`,
              bannerRef: 'abcdefabcdef',
            },
          ]}
          voiceChannelIds={[]}
          currentUserId="00000000-0000-0000-0000-00000000000a"
        />
      </I18nProvider>
    );

    const listAvatar = container.querySelector('aside img');
    expect(listAvatar?.getAttribute('src')).toBe(`/api/users/${MEMBER}/avatar?v=0123456789ab`);
    expect(document.body.innerHTML).not.toContain('/banner?v=');
    expect(document.body.innerHTML).not.toContain('data:');

    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    const dialog = await screen.findByRole('dialog');
    const banner = dialog.querySelector('[aria-hidden]') as HTMLElement | null;
    expect(banner?.style.backgroundImage).toContain(`/api/users/${MEMBER}/banner?v=abcdefabcdef`);
  });
});
