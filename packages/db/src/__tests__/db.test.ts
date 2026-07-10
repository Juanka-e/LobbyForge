import { describe, it, expect } from 'vitest';
import { parseDatabaseConfig, createMigrationRecord, createDb } from '../index.js';

describe('@lobbyforge/db', () => {
  it('parses a valid database config', () => {
    const config = parseDatabaseConfig({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lobbyforge',
      DATABASE_POOL_MAX: '20',
      DATABASE_SSL: 'true',
    });
    expect(config.url).toContain('postgresql://');
    expect(config.poolMax).toBe(20);
    expect(config.ssl).toBe(true);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseDatabaseConfig({})).toThrow('DATABASE_URL is required');
  });

  it('throws when DATABASE_POOL_MAX is invalid', () => {
    expect(() =>
      parseDatabaseConfig({
        DATABASE_URL: 'postgresql://x',
        DATABASE_POOL_MAX: 'not-a-number',
      })
    ).toThrow('DATABASE_POOL_MAX must be a positive integer');
  });

  it('createMigrationRecord assigns id and timestamp', () => {
    const rec = createMigrationRecord('0001_init');
    expect(rec.id).toMatch(/[0-9a-f-]{36}/i);
    expect(rec.name).toBe('0001_init');
    expect(rec.appliedAt).toBeInstanceOf(Date);
  });

  it('should construct the client wrapper successfully', () => {
    const fakeDbUri = 'postgres://user:pass@localhost:5432/db';
    const db = createDb(fakeDbUri);
    expect(db).toBeDefined();
    expect(db.query).toBeDefined();
  });
});
