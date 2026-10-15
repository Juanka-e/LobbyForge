// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import BansSection from '../BansSection';

const SERVER = '10000000-0000-4000-8000-000000000001';
const HOUR = 3_600_000;

let list: unknown[] = [];
let deleteAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, removed: true } };
const calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls.length = 0;
  list = [
    { id: 'b1', userId: 'u1', reason: 'spam links', expiresAt: null, createdAt: new Date(Date.now() - HOUR).toISOString(), displayName: 'Mallory' },
    { id: 'b2', userId: 'u2', reason: null, expiresAt: new Date(Date.now() + HOUR).toISOString(), createdAt: new Date().toISOString(), displayName: 'Trudy' },
    // An expired ban keeps nobody out: not listed.
    { id: 'b3', userId: 'u3', reason: null, expiresAt: new Date(Date.now() - HOUR).toISOString(), createdAt: new Date().toISOString(), displayName: 'Old' },
  ];
  deleteAnswer = { status: 200, body: { ok: true, removed: true } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (init?.method === 'DELETE') return Response.json(deleteAnswer.body, { status: deleteAnswer.status });
      return Response.json({ bans: list });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(locale = 'en') {
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <BansSection serverId={SERVER} />
    </I18nProvider>
  );
}

describe('BansSection — banned people and "Lift ban"', () => {
  it('lists the active bans with their reason and length, not the expired one', async () => {
    renderSection();
    expect(await screen.findByText('Mallory')).toBeInTheDocument();
    expect(screen.getByText('spam links')).toBeInTheDocument();
    expect(screen.getByText('Trudy')).toBeInTheDocument();
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.getByText('2 banned')).toBeInTheDocument();
  });

  it('asks first, then lifts the ban and drops the row', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: "Lift Mallory's ban" }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Lift ban' }));
    await waitFor(() => expect(screen.queryByText('Mallory')).toBeNull());
    expect(calls.find((call) => call.method === 'DELETE')?.url).toBe(`/api/servers/${SERVER}/bans?userId=u1`);
    expect(screen.getByText('Mallory is no longer banned.')).toBeInTheDocument();
  });

  it('a refusal is explained in the viewer’s language and the row stays', async () => {
    deleteAnswer = { status: 403, body: { error: 'You are timed out in this server', code: 'actor_timed_out' } };
    renderSection('tr');
    fireEvent.click(await screen.findByRole('button', { name: 'Mallory adlı kişinin yasağını kaldır' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yasağı kaldır' }));
    await waitFor(() => expect(screen.queryByText(/timed out/)).toBeNull());
    expect(await screen.findByText('Mallory')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).not.toBe('');
  });

  it('an empty list says nobody is banned', async () => {
    list = [];
    renderSection();
    expect(await screen.findByText('Nobody is banned.')).toBeInTheDocument();
  });
});
