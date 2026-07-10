import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Initializes and exports a Drizzle DB instance connected to the specified postgres database.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type DbClient = ReturnType<typeof createDb>;
