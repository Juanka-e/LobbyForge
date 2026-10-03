// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MyAccountBody from '../MyAccountBody';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

type BodyProps = Parameters<typeof MyAccountBody>[0];

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  displayName: 'Owner',
  email: 'owner@example.com',
  isGuest: false,
} as unknown as NonNullable<BodyProps['user']>;

function renderBody(locale = 'en') {
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <MyAccountBody user={user} signedIn />
    </I18nProvider>
  );
}

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Open the dialog, fill it with a valid change and submit. */
function submitChange(labels: { change: string; submit: string }) {
  fireEvent.click(screen.getByRole('button', { name: labels.change }));
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
  fireEvent.change(inputs[0], { target: { value: 'old password 1!' } });
  fireEvent.change(inputs[1], { target: { value: 'brand new password 2!' } });
  fireEvent.change(inputs[2], { target: { value: 'brand new password 2!' } });
  fireEvent.click(screen.getByRole('button', { name: labels.submit }));
}

const EN = { change: 'Change', submit: 'Update Password' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// security-review AUTH-001 follow-up: when the other sessions could not be
// signed out the password is STILL changed. The page must say so as a
// success with a translated warning, never as a failure that invites a
// retry with the old password.
describe('MyAccountBody — password change', () => {
  it('a change whose other sessions survived closes the dialog and warns, linking to Active Sessions', async () => {
    const fetchMock = respondWith(200, { status: 'changed', warning: 'sessions_not_revoked' });
    renderBody();
    submitChange(EN);

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(
      'Your password was changed, but your other sessions could not be signed out. Sign them out from Active Sessions.'
    );
    expect(screen.getByRole('link', { name: 'Active Sessions' })).toHaveAttribute('href', '/settings/active-sessions');
    // The dialog closed: no failure message, no submit button left.
    await waitFor(() => expect(screen.queryByRole('button', { name: EN.submit })).not.toBeInTheDocument());
    expect(screen.queryByText('Password could not be changed.')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/password', expect.objectContaining({ method: 'POST' }));
  });

  it('words the warning in the viewer\'s language', async () => {
    respondWith(200, { status: 'changed', warning: 'sessions_not_revoked' });
    renderBody('tr');
    submitChange({ change: 'Değiştir', submit: 'Şifreyi güncelle' });

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(
      'Şifren değiştirildi, ancak diğer oturumların kapatılamadı. Onları Etkin oturumlar sayfasından kapat.'
    );
  });

  it('a clean change shows a plain success', async () => {
    respondWith(200, { status: 'changed' });
    renderBody();
    submitChange(EN);

    expect(await screen.findByRole('status')).toHaveTextContent('Your password was changed.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a refused change keeps the dialog open with the error', async () => {
    respondWith(403, { error: 'Current password is incorrect.' });
    renderBody();
    submitChange(EN);

    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: EN.submit })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
