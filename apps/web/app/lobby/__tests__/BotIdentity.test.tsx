// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { BotAvatar, BotBadge, BotProfilePopover, type LobbyBot } from '../BotIdentity';

const BOT: LobbyBot = {
  id: 'b1',
  name: 'Announcer',
  type: 'custom',
  builtIn: false,
  trustLevel: 'unverified',
  permissions: ['send_messages', 'read_messages'],
  installedBy: 'Ayşe',
};

function renderIn(locale: string, ui: React.ReactElement) {
  return render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);
}

describe('BotBadge / BotAvatar', () => {
  it('marks a bot as a bot, in words and with a tooltip', () => {
    renderIn('en', <BotBadge />);
    const badge = screen.getByText('BOT');
    expect(badge).toHaveAttribute('title', 'This is a bot, not a person');
  });

  it('keeps "BOT" in Turkish and explains it in Turkish', () => {
    renderIn('tr', <BotBadge />);
    expect(screen.getByText('BOT')).toHaveAttribute('title', 'Bu bir bot, gerçek bir kişi değil');
  });

  it('draws the robot avatar, hidden from assistive tech (the name carries the meaning)', () => {
    const { container } = renderIn('en', <BotAvatar />);
    const avatar = container.querySelector('[data-bot-avatar]');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar?.textContent).toContain('smart_toy');
  });
});

describe('BotProfilePopover', () => {
  it('shows who installed the bot and what it may do', () => {
    renderIn('en', <BotProfilePopover bot={BOT} anchorRect={null} onClose={() => {}} canManage={false} />);
    const dialog = screen.getByRole('dialog', { name: 'Announcer bot profile' });
    expect(dialog).toHaveTextContent('BOT');
    expect(dialog).toHaveTextContent('Unverified');
    expect(dialog).toHaveTextContent('Connected through the Bot API');
    expect(dialog).toHaveTextContent('Installed by');
    expect(dialog).toHaveTextContent('Ayşe');
    expect(dialog).toHaveTextContent('Send messages');
    expect(dialog).toHaveTextContent('Read messages');
    expect(screen.queryByRole('link', { name: /Bot settings/ })).toBeNull();
  });

  it('gives managers a shortcut to the bot settings', () => {
    renderIn('en', <BotProfilePopover bot={BOT} anchorRect={null} onClose={() => {}} canManage />);
    expect(screen.getByRole('link', { name: /Bot settings/ })).toHaveAttribute('href', '/admin/settings/bots');
  });

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn();
    renderIn('en', <BotProfilePopover bot={BOT} anchorRect={null} onClose={onClose} canManage={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close bot profile' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reads in Turkish', () => {
    renderIn(
      'tr',
      <BotProfilePopover
        bot={{ ...BOT, builtIn: true, trustLevel: 'official', installedBy: null }}
        anchorRect={null}
        onClose={() => {}}
        canManage={false}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Announcer bot profili' });
    expect(dialog).toHaveTextContent('Resmî');
    expect(dialog).toHaveTextContent("LobbyForge'a yerleşik");
    expect(dialog).toHaveTextContent('Bilinmiyor');
    expect(dialog).toHaveTextContent('Mesaj gönder');
  });
});
