// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ProfileBody from '../ProfileBody';

type BodyProps = Parameters<typeof ProfileBody>[0];

function makeUser(overrides: Record<string, unknown> = {}): NonNullable<BodyProps['user']> {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    displayName: 'Ada',
    email: 'ada@example.com',
    isGuest: false,
    avatarUrl: null,
    bannerUrl: null,
    statusText: null,
    bio: null,
    ...overrides,
  } as unknown as NonNullable<BodyProps['user']>;
}

function renderBody(user: NonNullable<BodyProps['user']>, locale = 'en') {
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <ProfileBody user={user} serverProfile={null} />
    </I18nProvider>
  );
}

/** The banner upload answers `status`/`body`; anything else (the email status) answers a plain 200. */
function bannerResponds(status: number, body: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/users/me/banner')) return new Response(JSON.stringify(body), { status });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pickBannerFile() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'banner.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// security-review FILE-001: guests cannot store images.
describe('ProfileBody — guest images', () => {
  it('a guest sees why, the avatar button is disabled and the banner upload is gone', () => {
    bannerResponds(200, {});
    renderBody(makeUser({ isGuest: true, email: null }));

    const note = screen.getByText("Guests can't add an avatar or banner. Create an account to use your own images.");
    const avatar = screen.getByRole('button', { name: 'Change avatar' });
    expect(avatar).toBeDisabled();
    expect(avatar).toHaveAttribute('aria-describedby', note.id);
    expect(screen.queryByRole('button', { name: 'Add banner' })).not.toBeInTheDocument();
  });

  it('a guest can still remove a banner stored before the rule existed', () => {
    bannerResponds(200, { bannerUrl: null });
    renderBody(makeUser({ isGuest: true, email: null, bannerUrl: 'data:image/png;base64,AAAA' }));

    expect(screen.getByRole('button', { name: 'Remove banner' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Change banner' })).not.toBeInTheDocument();
  });

  it('says it in Turkish too', () => {
    bannerResponds(200, {});
    renderBody(makeUser({ isGuest: true, email: null }), 'tr');

    expect(screen.getByText('Misafirler avatar ya da afiş ekleyemez. Kendi görsellerini kullanmak için bir hesap oluştur.')).toBeInTheDocument();
  });

  it('an account sees the upload controls and no guest note', () => {
    bannerResponds(200, {});
    renderBody(makeUser());

    expect(screen.getByRole('button', { name: 'Add banner' })).toBeEnabled();
    expect(screen.queryByText(/Guests can't add/)).not.toBeInTheDocument();
  });
});

describe('ProfileBody — refused uploads are explained in the viewer\'s language', () => {
  it('429 upload_budget_exceeded', async () => {
    bannerResponds(429, { error: 'Daily image upload limit reached for your network. Try again later.', code: 'upload_budget_exceeded' });
    renderBody(makeUser());
    pickBannerFile();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've reached today's image upload limit for your network. Try again tomorrow."
    );
  });

  it('403 guest_upload_forbidden (Turkish)', async () => {
    bannerResponds(403, { error: 'Guest accounts cannot upload images.', code: 'guest_upload_forbidden' });
    renderBody(makeUser(), 'tr');
    pickBannerFile();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Misafirler avatar ya da afiş ekleyemez. Kendi görsellerini kullanmak için bir hesap oluştur.'
    );
  });
});
