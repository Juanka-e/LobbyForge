import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { QUIZ_PACKS } from '../packs/server';

/**
 * The built-in packs' questions carry their answers, so they must never be
 * reachable from what browsers load: the plugin's main entry (`src/index.ts`,
 * which the host's client-safe registry imports) and the panel
 * (`src/renderClient.tsx`). They live behind the server-only
 * `@lobbyforge/quiz/packs` subpath (`src/packs/server.ts` → `src/packs/data/*`).
 *
 * This walks the real import graph — every `import`, `export … from` and
 * `import()` TypeScript's own scanner finds, type-only imports included —
 * and fails if a data file, the server entry or any pack question's text is
 * reachable. A bundler can only ship what the graph reaches.
 */

const SRC = resolve(__dirname, '..');
const rel = (file: string) => relative(SRC, file).split('\\').join('/');

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`cannot resolve "${specifier}" from ${rel(from)}`);
  return found;
}

/** Every file reachable from `entry`, and every bare (package) specifier imported on the way. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (file.endsWith('.json')) continue;
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of importedFiles) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

const CLIENT_ENTRIES = ['index.ts', 'renderClient.tsx'];
const questionTexts = QUIZ_PACKS.flatMap((pack) => pack.questions.map((question) => question.question));

describe.each(CLIENT_ENTRIES)('the client entry %s', (entry) => {
  const { files, packages } = importGraph(join(SRC, entry));
  const reachable = [...files].map(rel);

  it('reaches the panel, the rules and the pack catalogue (the walk works)', () => {
    expect(reachable).toContain('packs/catalog.ts');
    expect(reachable).toContain('actions.ts');
    expect(reachable).toContain('ui/SetupForm.tsx');
  });

  it('never reaches the server-only pack entry or the question data', () => {
    expect(reachable.filter((file) => file === 'packs/server.ts' || file.startsWith('packs/data/'))).toEqual([]);
    expect([...packages].filter((specifier) => specifier.startsWith('@lobbyforge/quiz'))).toEqual([]);
  });

  it('contains no pack question anywhere in its reachable source', () => {
    expect(questionTexts.length).toBeGreaterThanOrEqual(120);
    const leaks: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const question of questionTexts) if (text.includes(question)) leaks.push(`${rel(file)}: ${question}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('the server-only entry', () => {
  it('is where the questions are (so the checks above are not vacuous)', () => {
    const reachable = [...importGraph(join(SRC, 'packs', 'server.ts')).files].map(rel);
    expect(reachable.filter((file) => file.startsWith('packs/data/'))).toHaveLength(6);
  });

  it('is published as the `./packs` subpath, apart from the main entry', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string }>;
    };
    expect(manifest.exports['./packs']?.import).toBe('./src/packs/server.ts');
    expect(manifest.exports['.']?.import).toBe('./src/index.ts');
  });
});
