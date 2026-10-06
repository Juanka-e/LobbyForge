/**
 * An in-memory stand-in for the `@lobbyforge/db` email queries, faithful to
 * their conditions (one live challenge per user and purpose, the code
 * window and attempt cap, consume-once). The SQL itself is proven against
 * real Postgres in packages/db/src/__tests__/email.integration.test.ts.
 * Test-only.
 */
// Types only: this module is loaded from inside the `@lobbyforge/db` mock factory.
import type { EmailTokenProof, EmailTokenPurpose, InstanceMailSettings } from '@lobbyforge/db';

/** Mirrors `defaultInstanceMailSettings()` (0046 defaults). */
export function defaultMailRow(): InstanceMailSettings {
  return {
    instanceId: 'self-host',
    provider: 'none',
    region: null,
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    smtpUsername: null,
    smtpPasswordEncrypted: null,
    mailFrom: null,
    dailyLimit: null,
    lastTestAt: null,
    lastTestResult: null,
    lastTestFingerprint: null,
    verificationMode: 'off',
    verificationScope: { open_register: true, invite_register: false },
    enforcedSince: null,
    existingDeadline: null,
    disposableBlock: false,
    disposableOverrides: { allow: [], block: [] },
    updatedAt: null,
  };
}

export interface FakeUser {
  id: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  isGuest: boolean;
  locale: string;
  displayName: string;
  createdAt: Date;
  deletedAt: Date | null;
  passwordHash: string | null;
  signupChannel: 'open' | 'invite' | 'oauth' | 'setup' | null;
}

export interface FakeToken {
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  targetEmail: string;
  tokenHash: Buffer;
  codeHash: Buffer;
  codeAttempts: number;
  expiresAt: Date;
  codeExpiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export function createFakeEmailDb() {
  const users = new Map<string, FakeUser>();
  const tokens: FakeToken[] = [];
  const state = { settings: defaultMailRow() as InstanceMailSettings, ownerUserId: null as string | null, settingsUnreadable: false, userReadsFail: false };

  const live = (userId: string, purpose: EmailTokenPurpose) => tokens.find((t) => t.userId === userId && t.purpose === purpose && !t.consumedAt) ?? null;
  const emailState = (u: FakeUser) => ({
    id: u.id,
    email: u.email,
    emailVerifiedAt: u.emailVerifiedAt,
    isGuest: u.isGuest,
    locale: u.locale,
    displayName: u.displayName,
    createdAt: u.createdAt,
    deletedAt: u.deletedAt,
    hasPassword: u.passwordHash !== null,
    signupChannel: u.signupChannel,
  });
  const dropLive = (userId: string, purposes: EmailTokenPurpose[]) => {
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const t = tokens[i]!;
      if (t.userId === userId && !t.consumedAt && purposes.includes(t.purpose)) tokens.splice(i, 1);
    }
  };
  function consume(purpose: EmailTokenPurpose, proof: EmailTokenProof): FakeToken | null {
    const now = Date.now();
    const t = tokens.find((x) => x.id === proof.tokenId);
    if (!t || t.purpose !== purpose || t.consumedAt || t.expiresAt.getTime() <= now) return null;
    if (proof.kind === 'code' && (t.codeExpiresAt.getTime() <= now || t.codeAttempts > proof.maxAttempts)) return null;
    t.consumedAt = new Date();
    return t;
  }

  const fns = {
    replaceEmailToken: async (_db: unknown, input: Omit<FakeToken, 'codeAttempts' | 'consumedAt' | 'createdAt'>) => {
      for (let i = tokens.length - 1; i >= 0; i -= 1) {
        if (tokens[i]!.userId === input.userId && tokens[i]!.purpose === input.purpose && !tokens[i]!.consumedAt) tokens.splice(i, 1);
      }
      const row: FakeToken = { ...input, codeAttempts: 0, consumedAt: null, createdAt: new Date() };
      tokens.push(row);
      return { ...row };
    },
    getActiveEmailToken: async (_db: unknown, userId: string, purpose: EmailTokenPurpose) => {
      const t = live(userId, purpose);
      return t ? { ...t } : null;
    },
    getEmailTokenByHash: async (_db: unknown, hash: Buffer) => {
      const t = tokens.find((x) => x.tokenHash.equals(hash));
      return t ? { ...t } : null;
    },
    reserveEmailCodeAttempt: async (_db: unknown, id: string, max: number) => {
      const now = Date.now();
      const t = tokens.find(
        (x) => x.id === id && !x.consumedAt && x.codeAttempts < max && x.codeExpiresAt.getTime() > now && x.expiresAt.getTime() > now
      );
      if (!t) return null;
      t.codeAttempts += 1;
      return { ...t };
    },
    revokeEmailChallenges: async (_db: unknown, userId: string, purposes: EmailTokenPurpose[]) => dropLive(userId, purposes),
    deleteStaleEmailTokens: async () => 0,
    applyEmailVerification: async (_db: unknown, proof: EmailTokenProof) => {
      const t = consume('verify', proof);
      if (!t) return { ok: false, reason: 'gone' };
      const u = users.get(t.userId);
      if (!u || u.email !== t.targetEmail || u.deletedAt) return { ok: false, reason: 'email_mismatch' };
      u.emailVerifiedAt ??= new Date();
      return { ok: true, userId: u.id, email: t.targetEmail };
    },
    applyEmailChange: async (_db: unknown, proof: EmailTokenProof) => {
      const t = tokens.find((x) => x.id === proof.tokenId);
      const taken = t ? [...users.values()].some((u) => u.email === t.targetEmail && u.id !== t.userId) : false;
      if (t && taken && !t.consumedAt) return { ok: false, reason: 'email_taken' };
      const consumed = consume('change', proof);
      if (!consumed) return { ok: false, reason: 'gone' };
      const u = users.get(consumed.userId)!;
      const oldEmail = u.email;
      u.email = consumed.targetEmail;
      u.emailVerifiedAt = new Date();
      dropLive(u.id, ['reset', 'verify']);
      return { ok: true, userId: u.id, oldEmail, newEmail: consumed.targetEmail };
    },
    applyPasswordReset: async (_db: unknown, proof: EmailTokenProof, hash: string) => {
      const pending = tokens.find((x) => x.id === proof.tokenId);
      const owner = pending ? users.get(pending.userId) : undefined;
      if (pending && owner && !pending.consumedAt && owner.email !== pending.targetEmail) return { ok: false, reason: 'email_mismatch' };
      const t = consume('reset', proof);
      if (!t) return { ok: false, reason: 'gone' };
      const u = users.get(t.userId)!;
      u.passwordHash = hash;
      u.emailVerifiedAt ??= new Date();
      dropLive(u.id, ['change', 'reset']);
      return { ok: true, userId: u.id, email: u.email, emailVerified: true };
    },
    getUserEmailState: async (_db: unknown, id: string) => {
      if (state.userReadsFail) throw new Error('db down');
      const u = users.get(id);
      return u ? emailState(u) : null;
    },
    getUserEmailStateByEmail: async (_db: unknown, email: string) => {
      const u = [...users.values()].find((x) => x.email === email);
      return u ? emailState(u) : null;
    },
    isEmailTaken: async (_db: unknown, email: string, except?: string) => [...users.values()].some((u) => u.email === email && u.id !== except),
    changeUserEmailDirect: async (_db: unknown, id: string, email: string) => {
      if ([...users.values()].some((u) => u.email === email && u.id !== id)) return { ok: false, reason: 'email_taken' };
      const u = users.get(id)!;
      u.email = email;
      u.emailVerifiedAt = null;
      dropLive(id, ['reset', 'verify', 'change']);
      return { ok: true };
    },
    markUserEmailVerifiedForAddress: async (_db: unknown, id: string, email: string) => {
      const u = users.get(id);
      if (!u || u.deletedAt || u.email !== email.trim().toLowerCase()) return false;
      u.emailVerifiedAt ??= new Date();
      return true;
    },
    markUserEmailVerified: async (_db: unknown, id: string) => {
      const u = users.get(id);
      if (!u || u.deletedAt) return false;
      u.emailVerifiedAt ??= new Date();
      return true;
    },
    getUserCredentialsById: async (_db: unknown, id: string) => {
      const u = users.get(id);
      return u ? { id: u.id, email: u.email, displayName: u.displayName, passwordHash: u.passwordHash, isGuest: u.isGuest, deletedAt: u.deletedAt } : null;
    },
    getInstanceMailSettings: async () => {
      if (state.settingsUnreadable) throw new Error('db down');
      return { ...state.settings };
    },
    setInstanceMailSettings: async (_db: unknown, input: Record<string, unknown>) => {
      const next = { ...state.settings } as Record<string, unknown>;
      for (const [k, v] of Object.entries(input)) if (v !== undefined && k !== 'now' && k !== 'instanceId') next[k] = v;
      state.settings = next as unknown as InstanceMailSettings;
      return { ...state.settings };
    },
    recordInstanceMailTest: async (_db: unknown, input: { result: string; fingerprint: string | null; at?: Date }) => {
      state.settings = { ...state.settings, lastTestResult: input.result, lastTestFingerprint: input.fingerprint, lastTestAt: input.at ?? new Date() };
    },
    replaceUserPasswordHash: async (_db: unknown, input: { userId: string; currentPasswordHash: string; newPasswordHash: string }) => {
      const u = users.get(input.userId);
      if (!u || u.passwordHash !== input.currentPasswordHash) return false;
      u.passwordHash = input.newPasswordHash;
      dropLive(u.id, ['change', 'reset']);
      return true;
    },
    ensureEmailVerificationEnforcedSince: async () => {
      state.settings.enforcedSince ??= new Date();
      return state.settings.enforcedSince;
    },
    getInstanceSetupStatus: async () => ({ instanceId: 'self-host', instanceName: 'Test Guild', ownerUserId: state.ownerUserId, bootstrapVersion: 2 }),
    getInstanceBootstrapStatus: async () => ({ instanceId: 'self-host', firstServerId: '11111111-1111-4111-8111-111111111111', ownerUserId: state.ownerUserId }),
  };

  function addUser(overrides: Partial<FakeUser> & { id: string }): FakeUser {
    const user: FakeUser = {
      email: `${overrides.id.slice(0, 8)}@example.org`,
      emailVerifiedAt: null,
      isGuest: false,
      locale: 'en',
      displayName: 'Member',
      createdAt: new Date(),
      deletedAt: null,
      passwordHash: null,
      signupChannel: 'open',
      ...overrides,
    };
    users.set(user.id, user);
    return user;
  }

  function reset(): void {
    users.clear();
    tokens.length = 0;
    state.settings = defaultMailRow();
    state.ownerUserId = null;
    state.settingsUnreadable = false;
    state.userReadsFail = false;
  }

  return { fns, users, tokens, state, addUser, reset };
}

export type FakeEmailDb = ReturnType<typeof createFakeEmailDb>;

/** A configured transport (mailpit on the dev host) for the settings row. */
export function configuredMail(overrides: Partial<InstanceMailSettings> = {}): InstanceMailSettings {
  return {
    ...defaultMailRow(),
    provider: 'custom',
    smtpHost: 'localhost',
    smtpPort: 19525,
    smtpSecurity: 'none',
    mailFrom: 'LobbyForge <no-reply@example.org>',
    ...overrides,
  };
}
