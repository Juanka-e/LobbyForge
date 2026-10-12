// @vitest-environment happy-dom
/**
 * Admin → Overview → Default language: every installed language by its
 * own name and status, which step decides today (saved here, the env, or
 * English), and a save that goes to PUT /api/admin/default-locale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import type { DefaultLocaleAdminView } from '@/lib/i18n/instance-default';
import DefaultLanguageCard from '../DefaultLanguageCard';

const LOCALES: DefaultLocaleAdminView['locales'] = [
  { code: 'en', name: 'English', englishName: 'English', status: 'complete' },
  { code: 'de', name: 'Deutsch', englishName: 'German', status: 'partial' },
  { code: 'tr', name: 'Türkçe', englishName: 'Turkish', status: 'complete' },
];

function view(overrides: Partial<DefaultLocaleAdminView> = {}): DefaultLocaleAdminView {
  return { code: 'en', source: 'fallback', saved: null, savedInstalled: false, env: null, envInstalled: false, locales: LOCALES, ...overrides };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderCard(initial: DefaultLocaleAdminView, locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <DefaultLanguageCard initial={initial} />
    </I18nProvider>
  );
}

describe('DefaultLanguageCard', () => {
  it('lists every installed language by its own name, with its status, after "not set"', () => {
    renderCard(view());
    const select = screen.getByLabelText('Language');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual([
      'Not set (LOBBYFORGE_DEFAULT_LOCALE, else English)',
      'English — complete',
      'Deutsch (German) — in progress',
      'Türkçe (Turkish) — complete',
    ]);
    expect(screen.getByTestId('default-language-source')).toHaveTextContent('In effect: English, the built-in fallback');
  });

  it('says when the env decides, and when the saved value overrides it', () => {
    const { unmount } = renderCard(view({ code: 'tr', source: 'env', env: 'tr', envInstalled: true }));
    expect(screen.getByTestId('default-language-source')).toHaveTextContent('In effect: Türkçe, from LOBBYFORGE_DEFAULT_LOCALE');
    unmount();
    renderCard(view({ code: 'en', source: 'saved', saved: 'en', savedInstalled: true, env: 'tr', envInstalled: true }));
    expect(screen.getByTestId('default-language-source')).toHaveTextContent('In effect: English, saved here.');
    expect(screen.getByText(/takes precedence over LOBBYFORGE_DEFAULT_LOCALE \(Türkçe\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Language')).toHaveValue('en');
  });

  it('warns about an env value or a saved value that is not installed', () => {
    renderCard(view({ env: 'xx', envInstalled: false, saved: 'de-AT', savedInstalled: false }));
    expect(screen.getByText(/LOBBYFORGE_DEFAULT_LOCALE is set to “xx”/)).toBeInTheDocument();
    expect(screen.getByText(/The saved language “de-AT” is no longer installed/)).toBeInTheDocument();
  });

  it('saves the choice and shows what is in effect now', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(view({ code: 'tr', source: 'saved', saved: 'tr', savedInstalled: true })), { status: 200 })
    );
    renderCard(view());
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'tr' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Default language saved.'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/admin/default-locale');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'tr' });
    expect(screen.getByTestId('default-language-source')).toHaveTextContent('In effect: Türkçe, saved here.');
  });

  it('clears the saved value with "not set", and reports a failed save', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    renderCard(view({ code: 'tr', source: 'saved', saved: 'tr', savedInstalled: true }));
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: ':none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be saved'));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ locale: null });
  });

  it('reads in Turkish too', () => {
    renderCard(view({ code: 'tr', source: 'saved', saved: 'tr', savedInstalled: true }), 'tr');
    expect(screen.getByRole('heading', { name: 'Varsayılan dil' })).toBeInTheDocument();
    expect(screen.getByTestId('default-language-source')).toHaveTextContent('Geçerli dil: Türkçe, burada kaydedildi.');
    expect(within(screen.getByLabelText('Dil')).getByRole('option', { name: 'Deutsch (German) — devam ediyor' })).toBeInTheDocument();
  });
});
