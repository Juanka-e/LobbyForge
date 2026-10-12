// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { PluginCatalogRow } from '@lobbyforge/db';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MarketplaceGrid from '../MarketplaceGrid';
import { PluginApprovalDialog } from '../PluginApprovalDialog';

/**
 * A marketplace plugin that asks for more than the sandbox (outside sites,
 * its own website as the screen, host effects) is installed only after the
 * owner approves exactly that (docs/PLUGIN_UNLOCK_PLAN.md).
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (ui: ReactElement, locale = 'en') =>
  rtlRender(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);

const REQUESTED = {
  network: { connect: ['https://api.example.com'], media: ['https://cdn.example.com'] },
  uiUrl: 'https://game.example.com/play',
  permissions: ['timers' as const, 'chat' as const],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PluginApprovalDialog', () => {
  it('says in plain words what each request lets the plugin do', () => {
    render(
      <PluginApprovalDialog
        pluginName="Net Game"
        request={{ requested: REQUESTED, added: REQUESTED, previous: null }}
        busy={false}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Net Game asks for more access' });
    expect(within(dialog).getByText('game.example.com')).toBeInTheDocument();
    expect(within(dialog).getByText(/sees what each player sees in the game/)).toBeInTheDocument();
    expect(within(dialog).getByText('Send and receive data')).toBeInTheDocument();
    expect(within(dialog).getByText('api.example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Play sound and video')).toBeInTheDocument();
    expect(within(dialog).getByText('Act on its own after a delay (timers)')).toBeInTheDocument();
    expect(within(dialog).getByText('Post messages in the activity’s channel')).toBeInTheDocument();
    // A first install marks nothing as new.
    expect(within(dialog).queryByText('New')).toBeNull();
  });

  it('on an upgrade, marks only what the installed version had not approved', () => {
    render(
      <PluginApprovalDialog
        pluginName="Net Game"
        request={{
          requested: REQUESTED,
          added: { permissions: ['chat'] },
          previous: { network: REQUESTED.network, uiUrl: REQUESTED.uiUrl, permissions: ['timers'] },
        }}
        busy={false}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );
    const chat = screen.getByText('Post messages in the activity’s channel').closest('li')!;
    expect(within(chat).getByText('New')).toBeInTheDocument();
    expect(screen.getAllByText('New')).toHaveLength(1);
  });

  it('speaks Turkish', () => {
    render(
      <PluginApprovalDialog
        pluginName="Ağ Oyunu"
        request={{ requested: REQUESTED, added: REQUESTED, previous: null }}
        busy={false}
        onApprove={() => {}}
        onCancel={() => {}}
      />,
      'tr'
    );
    expect(screen.getByRole('dialog', { name: 'Ağ Oyunu daha fazla erişim istiyor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Onayla ve kur' })).toBeInTheDocument();
  });
});

describe('MarketplaceGrid install with an approval', () => {
  const plugin = {
    pluginId: 'net-game',
    name: 'Net Game',
    version: '1.2.0',
    publisher: 'Someone',
    trustLevel: 'unverified',
    summary: null,
    tags: [],
    playerConfig: null,
    downloadCount: 0,
    requiresVoiceRoom: false,
    iconUrl: null,
  } as unknown as PluginCatalogRow;

  it('asks the owner first, then sends back exactly what the bundle asked for', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { approve?: unknown };
        bodies.push(body);
        if (!body.approve) {
          return Response.json(
            { error: 'needs approval', code: 'approval_required', requested: REQUESTED, added: REQUESTED, previous: null },
            { status: 409 }
          );
        }
        return Response.json({ ok: true, approved: REQUESTED });
      })
    );
    render(<MarketplaceGrid plugins={[plugin]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: 'Net Game asks for more access' });
    // Nothing is installed until the owner approves.
    expect(screen.queryByText('Installed ✓')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and install' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Installed ✓' })).toBeInTheDocument());
    expect(bodies).toEqual([{ pluginId: 'net-game' }, { pluginId: 'net-game', approve: REQUESTED }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling installs nothing', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ code: 'approval_required', requested: REQUESTED, added: REQUESTED, previous: null }, { status: 409 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<MarketplaceGrid plugins={[plugin]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });
});
