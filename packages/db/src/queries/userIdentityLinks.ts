import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { userIdentityLinks } from '../schema.js';

export interface UserIdentityLinkRow {
  id: string;
  userId: string;
  provider: string;
  providerSubject: string;
  providerEmail: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
  linkedAt: Date;
  lastUsedAt: Date;
}

export interface CreateUserIdentityLinkInput {
  userId: string;
  provider: string;
  providerSubject: string;
  providerEmail?: string | null;
  emailVerified?: boolean;
  claims?: Record<string, unknown>;
}

export async function getIdentityLinkByProviderSubject(
  db: DbClient,
  provider: string,
  providerSubject: string
): Promise<UserIdentityLinkRow | null> {
  const [row] = await db
    .select()
    .from(userIdentityLinks)
    .where(and(
      eq(userIdentityLinks.provider, provider),
      eq(userIdentityLinks.providerSubject, providerSubject)
    ))
    .limit(1);
  return (row as UserIdentityLinkRow | undefined) ?? null;
}

export async function listUserIdentityLinks(
  db: DbClient,
  userId: string
): Promise<UserIdentityLinkRow[]> {
  const rows = await db
    .select()
    .from(userIdentityLinks)
    .where(eq(userIdentityLinks.userId, userId));
  return rows as UserIdentityLinkRow[];
}

export async function createUserIdentityLink(
  db: DbClient,
  input: CreateUserIdentityLinkInput
): Promise<UserIdentityLinkRow> {
  const [row] = await db
    .insert(userIdentityLinks)
    .values({
      userId: input.userId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      providerEmail: input.providerEmail ?? null,
      emailVerified: input.emailVerified ?? false,
      claims: input.claims ?? {},
    })
    .returning();
  if (!row) throw new Error('createUserIdentityLink: insert returned no rows');
  return row as UserIdentityLinkRow;
}

export async function touchUserIdentityLink(
  db: DbClient,
  id: string
): Promise<void> {
  await db
    .update(userIdentityLinks)
    .set({ lastUsedAt: new Date() })
    .where(eq(userIdentityLinks.id, id));
}
