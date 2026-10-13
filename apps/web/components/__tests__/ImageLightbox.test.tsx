// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { ImageLightbox } from '@/components/ImageLightbox';

/**
 * The shared image viewer: a modal dialog named after the image, focus on
 * the close button and kept inside, closed by Escape, the backdrop or the
 * X, with an "Open original" link — and focus back on the opener.
 */

const SRC = '/api/users/u1/avatar?v=0123456789ab';

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider {...providerPropsFor('en')}>
      <button type="button" onClick={() => setOpen(true)}>
        open viewer
      </button>
      <ImageLightbox
        open={open}
        src={SRC}
        alt="Ayşe's profile photo"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      />
    </I18nProvider>
  );
}

describe('ImageLightbox', () => {
  it('shows the image as a named modal dialog with an Open original link', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open viewer' }));
    const dialog = screen.getByRole('dialog', { name: "Ayşe's profile photo" });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('img', { name: "Ayşe's profile photo" })).toHaveAttribute('src', SRC);
    const original = screen.getByRole('link', { name: /Open original/ });
    expect(original).toHaveAttribute('href', SRC);
    expect(original).toHaveAttribute('target', '_blank');
    expect(original).toHaveAttribute('rel', 'noopener noreferrer');
    // The zoom-in is a CSS class that reduced motion switches off.
    expect(dialog.querySelector('figure')).toHaveClass('lf-zoom-in');
  });

  it('focuses the close button, keeps Tab inside, and Escape closes and returns focus', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'open viewer' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close image viewer' });
    expect(document.activeElement).toBe(close);
    // Tab from the last element wraps to the first one inside the viewer.
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a backdrop click and on the X', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'open viewer' }));
    const backdrop = screen.getByRole('dialog').querySelector('[aria-hidden]')!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'open viewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing without an image', () => {
    render(
      <I18nProvider {...providerPropsFor('en')}>
        <ImageLightbox open src={null} alt="nothing" onClose={() => {}} />
      </I18nProvider>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can leave the Open original link out', () => {
    render(
      <I18nProvider {...providerPropsFor('en')}>
        <ImageLightbox open src={SRC} alt="photo" originalHref={null} onClose={() => {}} />
      </I18nProvider>
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
