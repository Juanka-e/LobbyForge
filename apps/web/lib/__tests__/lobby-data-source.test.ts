import { describe, expect, it } from 'vitest';
import * as db from '@lobbyforge/db';

describe('lobby data source exports', () => {
  it('exports the block-list query used by the lobby server component', () => {
    expect(typeof db.getBlockedUserIds).toBe('function');
  });
});
