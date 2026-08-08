import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  users,
  servers,
  channels,
  systemUpdateEvents,
  systemUpdateRuns,
  cardPacks,
  cards,
  serverLocalCards,
  gameSessions,
  instanceSettings,
  userIdentityLinks,
} from '../schema.js';

describe('Database Schema Definitions', () => {
  it('should have correct table names', () => {
    expect(getTableName(users)).toBe('users');
    expect(getTableName(servers)).toBe('servers');
    expect(getTableName(channels)).toBe('channels');
    expect(getTableName(systemUpdateRuns)).toBe('system_update_runs');
    expect(getTableName(systemUpdateEvents)).toBe('system_update_events');
    expect(getTableName(cardPacks)).toBe('card_packs');
    expect(getTableName(cards)).toBe('cards');
    expect(getTableName(serverLocalCards)).toBe('server_local_cards');
    expect(getTableName(gameSessions)).toBe('game_sessions');
    expect(getTableName(userIdentityLinks)).toBe('user_identity_links');
  });

  it('stores external identity references without credential token columns', () => {
    expect(userIdentityLinks.userId.notNull).toBe(true);
    expect(userIdentityLinks.provider.notNull).toBe(true);
    expect(userIdentityLinks.providerSubject.notNull).toBe(true);
    expect(userIdentityLinks.emailVerified.default).toBe(false);
    expect('accessToken' in userIdentityLinks).toBe(false);
    expect('refreshToken' in userIdentityLinks).toBe(false);
  });

  it('should define display_name as not nullable in users schema', () => {
    expect(users.displayName.notNull).toBe(true);
  });

  it('defines secure instance registration and SEO defaults', () => {
    expect(instanceSettings.registrationMode.default).toBe('invite_only');
    expect(instanceSettings.guestAccessEnabled.default).toBe(true);
    expect(instanceSettings.seoIndexingEnabled.default).toBe(false);
    expect(instanceSettings.seoTitle.notNull).toBe(false);
    expect(instanceSettings.seoDescription.notNull).toBe(false);
    expect(instanceSettings.bootstrapVersion.notNull).toBe(true);
    expect(instanceSettings.bootstrapVersion.default).toBe(1);
  });

  it('should require card_packs.plugin_id and card_packs.slug', () => {
    expect(cardPacks.pluginId.notNull).toBe(true);
    expect(cardPacks.slug.notNull).toBe(true);
    expect(cardPacks.language.notNull).toBe(true);
    expect(cardPacks.isBuiltIn.notNull).toBe(true);
  });

  it('should require cards pack, ordinal, difficulty, and category metadata', () => {
    expect(cards.packId.notNull).toBe(true);
    expect(cards.ordinal.notNull).toBe(true);
    expect(cards.difficulty.notNull).toBe(true);
    expect(cards.difficulty.hasDefault).toBe(true);
    expect(cards.category.notNull).toBe(true);
    expect(cards.category.default).toBe('general');
  });

  it('should require server_local_cards.server_id, plugin_id, payload, difficulty', () => {
    expect(serverLocalCards.serverId.notNull).toBe(true);
    expect(serverLocalCards.pluginId.notNull).toBe(true);
    expect(serverLocalCards.payload.notNull).toBe(true);
    expect(serverLocalCards.difficulty.notNull).toBe(true);
    // category + createdBy are optional.
    expect(serverLocalCards.category.notNull).toBe(false);
    expect(serverLocalCards.createdBy.notNull).toBe(false);
  });

  it('should expose game_sessions.team_size and difficulty_distribution as nullable plugin-defined knobs', () => {
    expect(gameSessions.teamSize.notNull).toBe(false);
    expect(gameSessions.difficultyDistribution.notNull).toBe(false);
  });
});
