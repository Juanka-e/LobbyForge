// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HushleHowToPlayModal } from '../HushleHowToPlayModal';

describe('HushleHowToPlayModal', () => {
  it('renders nothing when open is false', () => {
    render(<HushleHowToPlayModal open={false} onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.queryByText('Hushle')).not.toBeInTheDocument();
  });

  it('renders the title, the three how-to steps, and the Start button when open', () => {
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByText('Hushle')).toBeInTheDocument();
    expect(screen.getByText('Join a voice room')).toBeInTheDocument();
    expect(screen.getByText('Describe the word')).toBeInTheDocument();
    expect(screen.getByText('Guess before time runs out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start in Voice Room/i })).toBeInTheDocument();
  });

  it('shows the default player + duration metadata when no metadata prop is given', () => {
    render(<HushleHowToPlayModal open onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByText('3–12 players')).toBeInTheDocument();
    expect(screen.getByText('10–30 min')).toBeInTheDocument();
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
