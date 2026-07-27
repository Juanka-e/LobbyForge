export * from './schema.js';
export * from './client.js';
export * from './queries/users.js';
export * from './queries/userIdentityLinks.js';
export * from './queries/servers.js';
export * from './queries/memberships.js';
export * from './queries/channels.js';
export * from './queries/messages.js';
export * from './queries/roles.js';
export * from './queries/invites.js';
export * from './queries/bans.js';
export * from './queries/auditLogs.js';
export * from './queries/gameSessions.js';
export * from './queries/pluginInstalls.js';
export * from './queries/serverAccessPolicies.js';
export * from './queries/serverVoiceSettings.js';
export * from './queries/bots.js';
export * from './queries/userSettings.js';
export { updateMemberNickname } from './queries/memberships.js';
export { updateUserKeybinds } from './queries/userSettings.js';
export * from './queries/userBlocks.js';
export * from './queries/dmChannels.js';
export * from './queries/registryInstances.js';
export * from './queries/pluginCatalog.js';
export * from './queries/instanceSettings.js';
export * from './queries/systemUpdates.js';
export * from './queries/cardPacks.js';
export * from './queries/serverLocalCards.js';
export * from './queries/componentMigrations.js';
export * from './queries/dmChannels.js';
export { sql, eq, and, or, desc, asc } from 'drizzle-orm';

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  ssl: boolean;
}

export function parseDatabaseConfig(
  env: Record<string, string | undefined>
): DatabaseConfig {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const poolMaxRaw = env.DATABASE_POOL_MAX;
  const poolMax = poolMaxRaw ? Number.parseInt(poolMaxRaw, 10) : 10;
  if (Number.isNaN(poolMax) || poolMax <= 0) {
    throw new Error('DATABASE_POOL_MAX must be a positive integer');
  }
  return {
    url,
    poolMax,
    ssl: env.DATABASE_SSL === 'true',
  };
}

export interface MigrationRecord {
  id: string;
  appliedAt: Date;
  name: string;
}

export function createMigrationRecord(name: string): MigrationRecord {
  return {
    id: crypto.randomUUID(),
    name,
    appliedAt: new Date(),
  };
}
