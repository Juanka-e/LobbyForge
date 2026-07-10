import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Next instrumentation boundary', () => {
  it('does not pull database or component migrations into the Edge webpack graph', () => {
    const source = readFileSync(resolve(process.cwd(), 'instrumentation.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@lobbyforge\/db['"]/);
    expect(source).not.toMatch(/import\(['"].*component-migrations['"]\)/);
  });
});
