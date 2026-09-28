// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { HushleHowToPlayModal } from '../HushleHowToPlayModal';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

// The modal speaks through `useT()`; render it in English, as the app does
// for an English-speaking visitor.
const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);

describe('HushleHowToPlayModal', () => {
  it('renders nothing when open is false', () => {
    render(<HushleHowToPlayModal open={false} onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.queryByText('Hushle')).not.toBeInTheDocument();
  });

  it('renders the title, the four how-to steps, and the Start button when open', () => {
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByText('Hushle')).toBeInTheDocument();
    expect(screen.getByText('Join a voice room')).toBeInTheDocument();
    expect(screen.getByText('Describe the word')).toBeInTheDocument();
    expect(screen.getByText('Guess out loud')).toBeInTheDocument();
    expect(screen.getByText('Catch a forbidden word')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start in Voice Room/i })).toBeInTheDocument();
  });

  it('tells the rules the game plays by', () => {
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={vi.fn()} />);
    // The other team busts; the host scores each card; one timer per turn;
    // the game opens in the lobby's centre column.
    expect(screen.getByText(/they press Bust and the explaining team loses a point/)).toBeInTheDocument();
    expect(screen.getByText(/The host scores each card/)).toBeInTheDocument();
    expect(screen.getByText(/A turn has one timer/)).toBeInTheDocument();
    expect(screen.getByText(/opens in the middle of the lobby/)).toBeInTheDocument();
  });

  it('shows the default player + duration metadata when no metadata prop is given', () => {
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByText('4–12 players')).toBeInTheDocument();
    expect(screen.getByText('10–30 min')).toBeInTheDocument();
    // Hushle ships with LobbyForge: an official app, not a community install.
    expect(screen.getByText('Official')).toBeInTheDocument();
    expect(screen.queryByText('Community installed')).not.toBeInTheDocument();
  });

  it('uses custom metadata when provided', () => {
    render(
      <HushleHowToPlayModal
        open
        onClose={vi.fn()}
        onStart={vi.fn()}
        metadata={{ players: '4 players', duration: '5 min' }}
      />
    );
    expect(screen.getByText('4 players')).toBeInTheDocument();
    expect(screen.getByText('5 min')).toBeInTheDocument();
  });

  it('fires onStart when the Start button is clicked', () => {
    const onStart = vi.fn();
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: /Start in Voice Room/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it('fires onClose when the Close (cancel) button is clicked', () => {
    const onClose = vi.fn();
    render(<HushleHowToPlayModal open onClose={onClose} onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
