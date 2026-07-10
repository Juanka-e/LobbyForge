import { describe, expect, it } from 'vitest';
import type { DbClient } from '../client.js';
import { runComponentDataMigrations } from '../queries/componentMigrations.js';

const unreachableDb = {} as DbClient;
const checksum = `sha256:${'a'.repeat(64)}` as const;

describe('runComponentDataMigrations plan validation', () => {
  it('rejects unsafe component identifiers before opening a transaction', async () => {
    await expect(runComponentDataMigrations(unreachableDb, {
      componentType: 'plugin',
      componentId: '../unsafe',
      migrations: [],
    })).rejects.toThrow(/Invalid component migration id/);
  });

  it('requires contiguous versions beginning at one', async () => {
    await expect(runComponentDataMigrations(unreachableDb, {
      componentType: 'game',
      componentId: 'hushle',
      migrations: [{ version: 2, checksum, run: async () => undefined }],
    })).rejects.toThrow(/contiguous from 1/);
  });

  it('requires a SHA-256 checksum', async () => {
    await expect(runComponentDataMigrations(unreachableDb, {
      componentType: 'bot',
      componentId: 'music-bot',
      migrations: [{
        version: 1,
        checksum: 'sha256:not-a-checksum',
        run: async () => undefined,
      }],
    })).rejects.toThrow(/Invalid checksum/);
  });
});
