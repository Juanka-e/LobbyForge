'use client';

import { useMemo, useState } from 'react';

export interface CardView {
  id: string;
  word: string;
  forbiddenWords: string;
  difficulty: string;
  category: string;
  ordinal: number;
}

export interface CardPackView {
  id: string;
  pluginId: string;
  slug: string;
  name: string;
  language: string;
  description: string | null;
  isBuiltIn: boolean;
  cardCount: number;
  cards: CardView[];
}

type Draft = { word: string; forbiddenWords: string; difficulty: string; category: string };

const EMPTY_DRAFT: Draft = { word: '', forbiddenWords: '', difficulty: 'easy', category: 'general' };

const DIFFICULTY_TONES: Record<string, string> = {
  easy: 'bg-success/15 text-success',
  medium: 'bg-warning/15 text-warning',
  hard: 'bg-danger/15 text-danger',
};

function parseForbidden(raw: string): string[] {
  // Accept comma, semicolon, or newline separated forbidden words.
  return raw
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 10);
}

export default function PluginsClient({
  initialPacks,
  loadError,
}: {
  initialPacks: CardPackView[];
  loadError: string | null;
}) {
  const [packs, setPacks] = useState(initialPacks);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(
    initialPacks.length > 0 ? initialPacks[0]!.id : null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create-pack form state.
  const [newPackName, setNewPackName] = useState('');
  const [newPackLanguage, setNewPackLanguage] = useState('');
  const [newPackDescription, setNewPackDescription] = useState('');

  // Add-card form state for the selected pack.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  // Inline-edit state: the card id being edited and its form values.
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);

  // Confirm-delete state for packs (cards delete without a modal — they're
  // one click to recreate, packs are not).
  const [pendingDeletePack, setPendingDeletePack] = useState<CardPackView | null>(null);

  const selectedPack = useMemo(
    () => packs.find((p) => p.id === selectedPackId) ?? null,
    [packs, selectedPackId]
  );

  async function reload() {
    const res = await fetch('/api/admin/card-packs', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Failed to reload packs (HTTP ${res.status})`);
    const data = (await res.json()) as { packs: CardPackView[] };
    setPacks(data.packs);
    if (data.packs.length === 0) {
      setSelectedPackId(null);
    } else if (!data.packs.some((p) => p.id === selectedPackId)) {
      setSelectedPackId(data.packs[0]!.id);
    }
  }

  async function call(body: Record<string, unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/card-packs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      await reload();
      setMessage(successMessage);
      return true;
    } catch (err) {
      setMessage((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createPack() {
    const language = newPackLanguage.trim().toLowerCase();
    if (!newPackName.trim() || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language)) {
      setMessage('Pack name and a valid language code (e.g. en, tr, de, pt-BR) are required.');
      return;
    }
    const ok = await call(
      {
        action: 'create-pack',
        name: newPackName.trim(),
        language,
        description: newPackDescription.trim() || undefined,
      },
      `Pack "${newPackName.trim()}" created. Add words below.`
    );
    if (ok) {
      setNewPackName('');
      setNewPackLanguage('');
      setNewPackDescription('');
    }
  }

  async function addCard() {
    if (!selectedPack) return;
    const forbidden = parseForbidden(draft.forbiddenWords);
    if (!draft.word.trim() || forbidden.length === 0) {
      setMessage('A word and at least one forbidden word are required.');
      return;
    }
    const ok = await call(
      {
        action: 'add-card',
        packId: selectedPack.id,
        word: draft.word.trim(),
        forbiddenWords: forbidden,
        difficulty: draft.difficulty,
        category: draft.category.trim() || 'general',
      },
      `Word "${draft.word.trim()}" added to ${selectedPack.name}.`
    );
    if (ok) setDraft({ ...EMPTY_DRAFT, difficulty: draft.difficulty, category: draft.category });
  }

  async function saveCardEdit() {
    if (!selectedPack || !editingCardId) return;
    const forbidden = parseForbidden(editDraft.forbiddenWords);
    if (!editDraft.word.trim() || forbidden.length === 0) {
      setMessage('A word and at least one forbidden word are required.');
      return;
    }
    const ok = await call(
      {
        action: 'update-card',
        cardId: editingCardId,
        word: editDraft.word.trim(),
        forbiddenWords: forbidden,
        difficulty: editDraft.difficulty,
        category: editDraft.category.trim() || 'general',
      },
      'Card updated.'
    );
    if (ok) setEditingCardId(null);
  }

  async function deleteCard(cardId: string) {
    await call({ action: 'delete-card', cardId }, 'Card deleted.');
  }

  async function deletePack(pack: CardPackView) {
    const ok = await call({ action: 'delete-pack', packId: pack.id }, `Pack "${pack.name}" deleted.`);
    if (ok) setPendingDeletePack(null);
  }

  async function duplicatePack(pack: CardPackView) {
    await call(
      { action: 'duplicate-pack', packId: pack.id },
      `Pack duplicated as "${pack.name} (copy)" — you can now edit the copy.`
    );
  }

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Plugins &amp; Word Packs</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Manage activity content for installed plugins. Hosts pick these packs when starting a game;
          create a pack in your own language and add your community&apos;s words.
        </p>
      </header>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Could not load card packs: {loadError}
        </div>
      ) : null}

      {/* ── Create pack ─────────────────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-text-secondary">
          New word pack
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          Any language works — use an ISO code like <code>en</code>, <code>tr</code>, <code>de</code>,{' '}
          <code>pt-BR</code>. The pack appears in the Hushle pack selector immediately.
        </p>
        <div className="grid gap-4 md:grid-cols-[1fr_160px_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">Pack name</span>
            <input
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder="Hushle — Deutsch (Community)"
              maxLength={100}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">Language</span>
            <input
              value={newPackLanguage}
              onChange={(e) => setNewPackLanguage(e.target.value)}
              placeholder="de"
              maxLength={10}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={busy}
            />
          </label>
          <button
            type="button"
            onClick={createPack}
            disabled={busy}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Working...' : 'Create pack'}
          </button>
        </div>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs text-text-muted">Description (optional)</span>
          <input
            value={newPackDescription}
            onChange={(e) => setNewPackDescription(e.target.value)}
            placeholder="Community-maintained German words"
            maxLength={500}
            className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
            disabled={busy}
          />
        </label>
        {message ? <p className="mt-3 text-xs text-text-secondary">{message}</p> : null}
      </section>

      {/* ── Pack selector ────────────────────────────────────────── */}
      {packs.length === 0 ? (
        <p className="text-sm text-text-muted">No word packs yet — create one above.</p>
      ) : (
        <section className="mb-4 flex flex-wrap items-center gap-2">
          {packs.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => {
                setSelectedPackId(pack.id);
                setEditingCardId(null);
                setMessage(null);
              }}
              className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                pack.id === selectedPackId
                  ? 'border-primary bg-primary/15 text-text-primary'
                  : 'border-border-subtle bg-surface-floating text-text-secondary hover:bg-surface-raised'
              }`}
            >
              {pack.name}
              <span className="ml-2 rounded-full bg-surface-container px-2 py-0.5 text-xs text-text-muted">
                {pack.language} · {pack.cardCount}
              </span>
              {pack.isBuiltIn ? (
                <span className="ml-1.5 text-xs text-text-muted" title="Built-in pack">
                  ★
                </span>
              ) : null}
            </button>
          ))}
        </section>
      )}

      {/* ── Selected pack detail ─────────────────────────────────── */}
      {selectedPack ? (
        <section className="rounded-xl border border-border-subtle bg-surface">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle p-5">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">{selectedPack.name}</h2>
              <p className="mt-1 text-xs text-text-muted">
                {selectedPack.slug} · language <code>{selectedPack.language}</code> ·{' '}
                {selectedPack.cardCount} words
                {selectedPack.isBuiltIn ? ' · built-in (re-seeded on boot)' : ''}
              </p>
              {selectedPack.description ? (
                <p className="mt-2 text-sm text-text-secondary">{selectedPack.description}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => duplicatePack(selectedPack)}
                disabled={busy}
                className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                Duplicate
              </button>
              {selectedPack.isBuiltIn ? (
                <span
                  className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-muted"
                  title="Built-in packs are immutable — duplicate to customise"
                >
                  Immutable
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setPendingDeletePack(selectedPack)}
                  disabled={busy}
                  className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Delete pack
                </button>
              )}
            </div>
          </div>

          {/* Add-card form (custom packs only — built-ins are immutable) */}
          {selectedPack.isBuiltIn ? (
            <div className="border-b border-border-subtle p-5">
              <div className="rounded-lg border border-border-subtle bg-surface-container/50 p-3 text-sm text-text-secondary">
                Built-in packs are immutable (the boot seeder maintains them). Use{' '}
                <strong className="text-text-primary">Duplicate</strong> above to create an editable
                copy with these words.
              </div>
            </div>
          ) : (
          <div className="border-b border-border-subtle p-5">
            <h3 className="mb-3 text-sm font-semibold text-text-primary">Add a word</h3>
            <div className="grid gap-3 md:grid-cols-[1fr_2fr_140px_140px_auto] md:items-end">
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">Word</span>
                <input
                  value={draft.word}
                  onChange={(e) => setDraft({ ...draft, word: e.target.value })}
                  maxLength={100}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">
                  Forbidden words (comma separated)
                </span>
                <input
                  value={draft.forbiddenWords}
                  onChange={(e) => setDraft({ ...draft, forbiddenWords: e.target.value })}
                  placeholder="fruit, red, pie"
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">Difficulty</span>
                <select
                  value={draft.difficulty}
                  onChange={(e) => setDraft({ ...draft, difficulty: e.target.value })}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">Category</span>
                <input
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  maxLength={60}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                onClick={addCard}
                disabled={busy}
                className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
          )}

          {/* Card table */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-container/40 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  <th className="px-5 py-3">Word</th>
                  <th className="px-5 py-3">Forbidden words</th>
                  <th className="px-5 py-3">Difficulty</th>
                  <th className="px-5 py-3">Category</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {selectedPack.cards.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-text-muted">
                      No words in this pack yet — add the first one above.
                    </td>
                  </tr>
                ) : (
                  selectedPack.cards.map((card) =>
                    editingCardId === card.id ? (
                      <tr key={card.id} className="bg-surface-container/30">
                        <td className="px-5 py-3">
                          <input
                            value={editDraft.word}
                            onChange={(e) => setEditDraft({ ...editDraft, word: e.target.value })}
                            maxLength={100}
                            className="w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text-primary"
                          />
                        </td>
                        <td className="px-5 py-3">
                          <input
                            value={editDraft.forbiddenWords}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, forbiddenWords: e.target.value })
                            }
                            className="w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text-primary"
                          />
                        </td>
                        <td className="px-5 py-3">
                          <select
                            value={editDraft.difficulty}
                            onChange={(e) => setEditDraft({ ...editDraft, difficulty: e.target.value })}
                            className="rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text-primary"
                          >
                            <option value="easy">Easy</option>
                            <option value="medium">Medium</option>
                            <option value="hard">Hard</option>
                          </select>
                        </td>
                        <td className="px-5 py-3">
                          <input
                            value={editDraft.category}
                            onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}
                            maxLength={60}
                            className="w-28 rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text-primary"
                          />
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={saveCardEdit}
                              disabled={busy}
                              className="rounded-md border border-success/40 px-3 py-1.5 text-xs text-success hover:bg-success/10 disabled:opacity-40"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingCardId(null)}
                              disabled={busy}
                              className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised disabled:opacity-40"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={card.id} className="transition-colors hover:bg-surface-raised/50">
                        <td className="px-5 py-3 font-medium text-text-primary">{card.word}</td>
                        <td className="px-5 py-3 text-text-secondary">{card.forbiddenWords}</td>
                        <td className="px-5 py-3">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              DIFFICULTY_TONES[card.difficulty] ?? 'bg-surface-container text-text-secondary'
                            }`}
                          >
                            {card.difficulty}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-text-secondary">{card.category}</td>
                        <td className="px-5 py-3">
                          {selectedPack.isBuiltIn ? (
                            <span className="block text-right text-xs text-text-muted">—</span>
                          ) : (
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCardId(card.id);
                                  setEditDraft({
                                    word: card.word,
                                    forbiddenWords: card.forbiddenWords,
                                    difficulty: card.difficulty,
                                    category: card.category,
                                  });
                                }}
                                disabled={busy}
                                className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteCard(card.id)}
                                disabled={busy}
                                className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  )
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Delete-pack confirmation modal ───────────────────────── */}
      {pendingDeletePack ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-semibold text-text-primary">Delete word pack?</h2>
            <p className="mt-2 text-sm text-text-secondary">
              <span className="font-medium text-text-primary">{pendingDeletePack.name}</span> and its{' '}
              {pendingDeletePack.cardCount} words will be removed. Games already in progress keep
              their dealt cards, but new games will no longer offer this pack.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeletePack(null)}
                disabled={busy}
                className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text-secondary hover:bg-surface-raised disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deletePack(pendingDeletePack)}
                disabled={busy}
                className="rounded-lg border border-danger/50 bg-danger/10 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-40"
              >
                {busy ? 'Deleting...' : 'Delete pack'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
