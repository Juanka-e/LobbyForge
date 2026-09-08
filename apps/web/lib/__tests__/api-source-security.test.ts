import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

describe('API source security invariants', () => {
  const apiRoot = join(process.cwd(), 'app', 'api');
  const routeFiles = filesBelow(apiRoot).filter((file) => file.endsWith('route.ts'));

  it('never returns raw caught error messages to API clients', () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?:detail|error):\s*(?:\(err as Error\)|\w+\.error)\.message/);
    }
  });

  it('keeps every non-stream production route behind the shared API boundary', () => {
    const exceptions = new Set([
      join(apiRoot, 'test', 'db-reset', 'route.ts'),
      join(apiRoot, 'test', 'redis-reset', 'route.ts'),
    ]);
    for (const file of routeFiles) {
      if (file.includes(`${join('activities', '[sessionId]', 'stream')}`) || exceptions.has(file)) continue;
      // Browser routes use withApiSecurity; signed machine routes
      // (9th-audit) use withMachineApiSecurity — both are the shared
      // boundary, both enforce method/body/rate limits.
      const source = readFileSync(file, 'utf8');
      expect(
        source.includes('withApiSecurity') || source.includes('withMachineApiSecurity'),
        file
      ).toBe(true);
    }
  });
});
