// @vitest-environment happy-dom
/**
 * The setup wizard's first step, "Language / Dil" (docs/TRANSLATING.md):
 * it lists every language found on disk — one added later included, with
 * no code change — switches the wizard at once when one is picked, and
 * sends the choice with the final POST, where it becomes the instance
 * default and the owner's language.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MESSAGES_ROOT } from '@/lib/i18n/catalogue';
import SetupWizard from '../SetupWizard';
import { SETUP_MESSAGE_PREFIX, setupLanguages } from '../setup-languages';

// A copy of the shipped catalogues plus a German translation someone just
// dropped in — half done, as a community translation usually starts.
const root = mkdtempSync(join(tmpdir(), 'lf-setup-langs-'));
cpSync(join(MESSAGES_ROOT, 'en'), join(root, 'en'), { recursive: true });
cpSync(join(MESSAGES_ROOT, 'tr'), join(root, 'tr'), { recursive: true });
mkdirSync(join(root, 'de'));
writeFileSync(join(root, 'de', '_locale.json'), JSON.stringify({ name: 'Deutsch', englishName: 'German', dir: 'ltr', status: 'partial' }));
writeFileSync(join(root, 'de', 'auth.json'), JSON.stringify({ 'auth.setup.steps.language.label': 'Sprache', 'auth.setup.continue': 'Weiter' }));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'completed' }), { status: 200 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'lf_locale=; Path=/; Max-Age=0';
  document.documentElement.lang = 'en';
});

afterEach(() => vi.unstubAllGlobals());

function renderWizard(initialLocale = 'en') {
  return render(
    <SetupWizard
      defaultInstanceName="Kaplan Guild"
      defaultOwnerDisplayName=""
      setupTokenRequired={false}
      instanceId="self-host"
      isOfficialHost={false}
      languages={setupLanguages(root)}
      initialLocale={initialLocale}
    />
  );
}

describe('setupLanguages', () => {
  it('discovers every language on disk and sends only the setup strings, merged over English', () => {
    const languages = setupLanguages(root);
    expect(languages.map((l) => l.info.code)).toEqual(['en', 'de', 'tr']);
    const de = languages.find((l) => l.info.code === 'de')!;
    expect(de.info.status).toBe('partial');
    expect(de.messages['auth.setup.steps.language.label']).toBe('Sprache');
    // Not translated yet: English fills the gap.
    expect(de.messages['auth.setup.finish']).toBe('Complete setup');
    expect(Object.keys(de.messages).every((key) => key.startsWith(SETUP_MESSAGE_PREFIX))).toBe(true);
  });
});

describe('SetupWizard — the language step', () => {
  it('comes first and lists every installed language in its own name, the new one included', () => {
    renderWizard();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 1 of 6 · Language');
    const group = screen.getByRole('radiogroup', { name: 'Language' });
    const options = within(group).getAllByRole('radio');
    expect(options.map((o) => o.getAttribute('lang'))).toEqual(['en', 'de', 'tr']);
    expect(within(group).getByRole('radio', { name: /Türkçe/ })).toHaveTextContent('Turkish');
    expect(within(group).getByRole('radio', { name: /Deutsch/ })).toHaveTextContent('In progress');
    expect(within(group).getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('starts on the language the page was opened in', () => {
    renderWizard('tr');
    expect(screen.getByRole('radio', { name: /Türkçe/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Adım 1/6 · Dil');
  });

  it('switches the wizard to the picked language at once, and remembers it in the cookie', () => {
    const { container } = renderWizard();
    fireEvent.click(screen.getByRole('radio', { name: /Türkçe/ }));
    expect(screen.getByRole('radio', { name: /Türkçe/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Adım 1/6 · Dil');
    expect(screen.getByRole('button', { name: 'Devam et' })).toBeInTheDocument();
    // Tagged with its language, for casing and screen readers.
    expect(container.querySelector('section')).toHaveAttribute('lang', 'tr');
    expect(document.documentElement.lang).toBe('tr');
    expect(document.cookie).toContain('lf_locale=tr');
  });

  it('renders a half-translated language with English filling the gaps', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('radio', { name: /Deutsch/ }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 1 of 6 · Sprache');
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeInTheDocument();
  });

  it('keeps the chosen language on every later step and sends it with the final POST', async () => {
    renderWizard();
    fireEvent.click(screen.getByRole('radio', { name: /Türkçe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Adım 2/6');
    expect(screen.getByLabelText(/^Kurulum adı/)).toHaveValue('Kaplan Guild');
    fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));

    fireEvent.change(screen.getByLabelText(/^Sahibin görünen adı/), { target: { value: 'Juanka' } });
    fireEvent.change(screen.getByLabelText(/^Sahibin e-postası/), { target: { value: 'owner@example.org' } });
    fireEvent.change(screen.getByLabelText(/^Sahibin şifresi/), { target: { value: 'a long enough password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));
    fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));
    fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));

    // The review lists the language with everything else.
    expect(screen.getByText('Dil', { selector: 'dt' }).nextElementSibling).toHaveTextContent('Türkçe');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Kurulumu tamamla' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/setup/complete');
    expect(JSON.parse(String(init!.body))).toMatchObject({ locale: 'tr', ownerEmail: 'owner@example.org' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/lobby'));
    assign.mockRestore();
  });
});
