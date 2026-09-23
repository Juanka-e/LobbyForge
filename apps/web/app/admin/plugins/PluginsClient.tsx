'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';

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
}

type Draft = { word: string; forbiddenWords: string; difficulty: string; category: string };

const EMPTY_DRAFT: Draft = { word: '', forbiddenWords: '', difficulty: 'easy', category: 'general' };

const DIFFICULTY_LABEL_KEYS: Record<string, string> = {
  easy: 'admin.plugins.difficulty.easy',
  medium: 'admin.plugins.difficulty.medium',
  hard: 'admin.plugins.difficulty.hard',
};

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
  const t = useT();
  const [packs, setPacks] = useState(initialPacks);
  // V4-011: cards load lazily per selected pack (?packId=…); undefined
  // means "not loaded yet", null means "loading failed".
  const [cardsByPack, setCardsByPack] = useState<
    Record<string, { status: 'loading' | 'ready' | 'error'; cards: CardView[] } | undefined>
  >({});
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
  const [pendingDeleteCard, setPendingDeleteCard] = useState<CardView | null>(null);

  const selectedPack = useMemo(
    () => packs.find((p) => p.id === selectedPackId) ?? null,
    [packs, selectedPackId]
  );

  // Lazy card detail (V4-011): fetch the selected pack's cards once per
  // cache invalidation. V5-008: a real tri-state — 'loading' / 'ready' /
  // 'error' — a failed load is NO longer masked as an empty pack.
  useEffect(() => {
    if (!selectedPackId) return;
    if (cardsByPack[selectedPackId] !== undefined) return;
    let cancelled = false;
    setCardsByPack((prev) => ({ ...prev, [selectedPackId]: { status: 'loading', cards: [] } }));
    (async () => {
      try {
        const res = await fetch(`/api/admin/card-packs?packId=${selectedPackId}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { cards: CardView[] };
        if (!cancelled)
          setCardsByPack((prev) => ({ ...prev, [selectedPackId]: { status: 'ready', cards: data.cards } }));
      } catch {
        if (!cancelled)
          setCardsByPack((prev) => ({ ...prev, [selectedPackId]: { status: 'error', cards: [] } }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPackId, cardsByPack]);

  const cardState = selectedPackId ? cardsByPack[selectedPackId] : undefined;

  async function reload(): Promise<CardPackView[]> {
    const res = await fetch('/api/admin/card-packs', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(t('admin.plugins.reloadFailed', { status: res.status }));
    const data = (await res.json()) as { packs: CardPackView[] };
    setPacks(data.packs);
    if (data.packs.length === 0) {
      setSelectedPackId(null);
    } else if (!data.packs.some((p) => p.id === selectedPackId)) {
      setSelectedPackId(data.packs[0]!.id);
    }
    return data.packs;
  }

  /** Drop the cached cards for a pack so the loader effect refetches. */
  function invalidateCards(packId: string | null) {
    if (!packId) return;
    setCardsByPack((prev) => ({ ...prev, [packId]: undefined }));
  }

  async function call(
    body: Record<string, unknown>,
    successMessage: string,
    selectPackId?: string
  ): Promise<CardPackView[] | null> {
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
      const reloaded = await reload();
      const target = selectPackId ?? selectedPackId;
      if (selectPackId) setSelectedPackId(selectPackId);
      invalidateCards(target);
      setMessage(successMessage);
      return reloaded;
    } catch (err) {
      setMessage((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createPack() {
    const language = newPackLanguage.trim().toLowerCase();
    if (!newPackName.trim() || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language)) {
      setMessage(t('admin.plugins.packInvalid'));
      return;
    }
    const name = newPackName.trim();
    const ok = await call(
      {
        action: 'create-pack',
        name,
        language,
        description: newPackDescription.trim() || undefined,
      },
      t('admin.plugins.packCreated', { name })
    );
    if (ok) {
      setNewPackName('');
      setNewPackLanguage('');
      setNewPackDescription('');
      // V5-008: select the freshly created pack so "add words below"
      // targets it immediately (match by unique name in the RELOADED
      // list — reading `packs` here would be a stale-closure race).
      const created = ok.find((p) => p.name === name);
      if (created) {
        setSelectedPackId(created.id);
        invalidateCards(created.id);
      }
    }
  }

  async function addCard() {
    if (!selectedPack) return;
    const forbidden = parseForbidden(draft.forbiddenWords);
    if (!draft.word.trim() || forbidden.length === 0) {
      setMessage(t('admin.plugins.wordInvalid'));
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
      t('admin.plugins.wordAdded', { word: draft.word.trim(), pack: selectedPack.name })
    );
    if (ok) setDraft({ ...EMPTY_DRAFT, difficulty: draft.difficulty, category: draft.category });
  }

  async function saveCardEdit() {
    if (!selectedPack || !editingCardId) return;
    const forbidden = parseForbidden(editDraft.forbiddenWords);
    if (!editDraft.word.trim() || forbidden.length === 0) {
      setMessage(t('admin.plugins.wordInvalid'));
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
      t('admin.plugins.wordUpdated')
    );
    if (ok) setEditingCardId(null);
  }

  async function deleteCard(cardId: string): Promise<boolean> {
    return (await call({ action: 'delete-card', cardId }, t('admin.plugins.wordDeleted'))) !== null;
  }

  async function deletePack(pack: CardPackView) {
    const ok = await call(
      { action: 'delete-pack', packId: pack.id },
      t('admin.plugins.packDeleted', { name: pack.name })
    );
    if (ok) setPendingDeletePack(null);
  }

  async function duplicatePack(pack: CardPackView) {
    // The copy's name is deterministic — pick it out of the RELOADED
    // summaries and select it (V5-008). The " (copy)" suffix is the name
    // the SERVER gives the copy, so it is matched verbatim, not translated.
    const copyName = `${pack.name} (copy)`.slice(0, 100);
    const reloaded = await call(
      { action: 'duplicate-pack', packId: pack.id },
      t('admin.plugins.packDuplicated', { name: copyName })
    );
    const copy = reloaded?.find((p) => p.name === copyName);
    if (copy) {
      setSelectedPackId(copy.id);
      invalidateCards(copy.id);
    }
  }

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('admin.plugins.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('admin.plugins.intro')}</p>
      </header>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('admin.plugins.loadError', { error: loadError })}
        </div>
      ) : null}

      {/* ── Create pack ─────────────────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-text-secondary">
          {t('admin.plugins.newPack')}
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          {rich(t('admin.plugins.newPackHint'), {
            examples: (
              <>
                <code>en</code>, <code>tr</code>, <code>de</code>, <code>pt-BR</code>
              </>
            ),
          })}
        </p>
        <div className="grid gap-4 md:grid-cols-[1fr_160px_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.packName')}</span>
            <input
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder={t('admin.plugins.packNamePlaceholder')}
              maxLength={100}
              className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.language')}</span>
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
            {busy ? t('admin.plugins.working') : t('admin.plugins.createPack')}
          </button>
        </div>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.description')}</span>
          <input
            value={newPackDescription}
            onChange={(e) => setNewPackDescription(e.target.value)}
            placeholder={t('admin.plugins.descriptionPlaceholder')}
            maxLength={500}
            className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
            disabled={busy}
          />
        </label>
        {message ? <p className="mt-3 text-xs text-text-secondary">{message}</p> : null}
      </section>

      {/* ── Pack selector ────────────────────────────────────────── */}
      {packs.length === 0 ? (
        <p className="text-sm text-text-muted">{t('admin.plugins.noPacks')}</p>
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
                <span className="ml-1.5 text-xs text-text-muted" title={t('admin.plugins.builtInTitle')}>
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
                {rich(t('admin.plugins.packMeta', { slug: selectedPack.slug, count: selectedPack.cardCount }), { language: <code>{selectedPack.language}</code> })}
                {selectedPack.isBuiltIn ? ` · ${t('admin.plugins.packMetaBuiltIn')}` : ''}
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
                {t('admin.plugins.duplicate')}
              </button>
              {selectedPack.isBuiltIn ? (
                <span
                  className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-muted"
                  title={t('admin.plugins.immutableTitle')}
                >
                  {t('admin.plugins.immutable')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setPendingDeletePack(selectedPack)}
                  disabled={busy}
                  className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('admin.plugins.deletePack')}
                </button>
              )}
            </div>
          </div>

          {/* Add-card form (custom packs only — built-ins are immutable) */}
          {selectedPack.isBuiltIn ? (
            <div className="border-b border-border-subtle p-5">
              <div className="rounded-lg border border-border-subtle bg-surface-container/50 p-3 text-sm text-text-secondary">
                {rich(t('admin.plugins.builtInNotice'), {
                  duplicate: <strong className="text-text-primary">{t('admin.plugins.duplicate')}</strong>,
                })}
              </div>
            </div>
          ) : (
          <div className="border-b border-border-subtle p-5">
            <h3 className="mb-3 text-sm font-semibold text-text-primary">{t('admin.plugins.addWord')}</h3>
            <div className="grid gap-3 md:grid-cols-[1fr_2fr_140px_140px_auto] md:items-end">
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.word')}</span>
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
                  {t('admin.plugins.forbiddenLabel')}
                </span>
                <input
                  value={draft.forbiddenWords}
                  onChange={(e) => setDraft({ ...draft, forbiddenWords: e.target.value })}
                  placeholder={t('admin.plugins.forbiddenPlaceholder')}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.difficulty')}</span>
                <select
                  value={draft.difficulty}
                  onChange={(e) => setDraft({ ...draft, difficulty: e.target.value })}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
                  disabled={busy}
                >
                  <option value="easy">{t('admin.plugins.difficulty.easy')}</option>
                  <option value="medium">{t('admin.plugins.difficulty.medium')}</option>
                  <option value="hard">{t('admin.plugins.difficulty.hard')}</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-text-muted">{t('admin.plugins.category')}</span>
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
                {t('admin.plugins.add')}
              </button>
            </div>
          </div>
          )}

          {/* Card table */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-container/40 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  <th className="px-5 py-3">{t('admin.plugins.word')}</th>
                  <th className="px-5 py-3">{t('admin.plugins.forbiddenWords')}</th>
                  <th className="px-5 py-3">{t('admin.plugins.difficulty')}</th>
                  <th className="px-5 py-3">{t('admin.plugins.category')}</th>
                  <th className="px-5 py-3 text-right">{t('admin.plugins.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {cardState?.status === 'loading' || cardState === undefined ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-text-muted">
                      {t('admin.plugins.loadingWords')}
                    </td>
                  </tr>
                ) : cardState.status === 'error' ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center">
                      <span className="text-danger">{t('admin.plugins.loadWordsFailed')}</span>{' '}
                      <button
                        type="button"
                        onClick={() => invalidateCards(selectedPackId)}
                        className="ml-2 rounded-md border border-border-strong px-3 py-1 text-xs text-text-secondary hover:bg-surface-raised"
                      >
                        {t('admin.plugins.retry')}
                      </button>
                    </td>
                  </tr>
                ) : cardState.cards.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-text-muted">
                      {t('admin.plugins.noWords')}
                    </td>
                  </tr>
                ) : (
                  cardState.cards.map((card) =>
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
                            <option value="easy">{t('admin.plugins.difficulty.easy')}</option>
                            <option value="medium">{t('admin.plugins.difficulty.medium')}</option>
                            <option value="hard">{t('admin.plugins.difficulty.hard')}</option>
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
                              {t('common.save')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingCardId(null)}
                              disabled={busy}
                              className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised disabled:opacity-40"
                            >
                              {t('common.cancel')}
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
                            {DIFFICULTY_LABEL_KEYS[card.difficulty]
                              ? t(DIFFICULTY_LABEL_KEYS[card.difficulty]!)
                              : card.difficulty}
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
                                {t('admin.plugins.edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDeleteCard(card)}
                                disabled={busy}
                                className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {t('admin.plugins.delete')}
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

      {/* ── Confirmations ─────────────────────────────────────────── */}
      {pendingDeleteCard ? (
        <ConfirmModal
          title={t('admin.plugins.deleteWordTitle')}
          body={rich(t('admin.plugins.deleteWordBody', { pack: selectedPack?.name ?? '' }), {
            word: <span className="font-medium text-text-primary">{pendingDeleteCard.word}</span>,
          })}
          confirmLabel={busy ? t('admin.plugins.deleting') : t('admin.plugins.deleteWord')}
          busy={busy}
          onCancel={() => setPendingDeleteCard(null)}
          onConfirm={async () => {
            const ok = await deleteCard(pendingDeleteCard.id);
            if (ok) setPendingDeleteCard(null);
          }}
        />
      ) : null}

      {pendingDeletePack ? (
        <ConfirmModal
          title={t('admin.plugins.deletePackTitle')}
          body={rich(t('admin.plugins.deletePackBody', { count: pendingDeletePack.cardCount }), {
            pack: <span className="font-medium text-text-primary">{pendingDeletePack.name}</span>,
          })}
          confirmLabel={busy ? t('admin.plugins.deleting') : t('admin.plugins.deletePack')}
          busy={busy}
          onCancel={() => setPendingDeletePack(null)}
          onConfirm={async () => {
            await deletePack(pendingDeletePack);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Accessible confirmation dialog: role="dialog" + aria-modal, Escape to
 * cancel, initial focus on the safe (cancel) action. A full focus trap
 * is overkill for a two-button dialog — Escape + initial focus cover the
 * keyboard path; the overlay click target is not a close affordance on
 * purpose (destructive actions shouldn't close on stray clicks).
 */
function ConfirmModal({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        <p className="mt-2 text-sm text-text-secondary">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text-secondary hover:bg-surface-raised disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            className="rounded-lg border border-danger/50 bg-danger/10 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
