/**
 * The session secret every LobbyForge process signs and verifies cookies
 * with (`LOBBYFORGE_SESSION_SECRET`): the web app, the ws-gateway and the
 * internal service signatures derived from it.
 *
 * security-review INFRA-V-02: a secret that is long enough is not
 * necessarily secret. The values published in this repository — the
 * `.env.example` placeholders and the dev compose default — are known to
 * everyone, and a process running with one can have any session cookie
 * forged against it. Those are refused unless the process runs inside the
 * local dev stack, which says so explicitly with `LOBBYFORGE_DEV_STACK=true`
 * (set by `infra/docker/docker-compose.dev.yml` only — never in a deploy).
 */

export const SESSION_SECRET_MIN_LENGTH = 32;

/** The env flag the dev compose sets; it is the only way a placeholder secret is accepted. */
export const DEV_STACK_ENV = 'LOBBYFORGE_DEV_STACK';

/**
 * Shapes of the placeholder values this repository publishes (env examples,
 * the dev compose default, the README) and of the obvious "fill me in"
 * strings people paste. A real secret is random, so none of these words
 * appear in one by accident.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /replace[_\- ]?me/i, // .env.example: replace_me_with_at_least_32_chars_of_random_hex
  /change[_\- ]?me/i, // .env.prod.example: CHANGE_ME_64_char_hex
  /change[_\- ]?before/i, // dev compose: dev_session_secret_change_before_public_use_1234
  /please[_\- ]?change/i,
  /dev[_\- ]?session[_\- ]?secret/i,
  /your[_\- ]?(session[_\- ]?)?secret/i,
  /placeholder/i,
  /random[_\- ]?hex/i,
  /^<.*>$/, // README: <at least 32 chars of random hex>
];

export type SessionSecretProblem = 'missing' | 'too_short' | 'placeholder';

/** Is this value one of the published placeholders (or shaped like one)? */
export function isPlaceholderSessionSecret(secret: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(secret));
}

/** Does this environment declare the local dev stack? Only the exact string `true` counts. */
export function isDevStack(env: Record<string, string | undefined> = process.env): boolean {
  return env[DEV_STACK_ENV] === 'true';
}

/**
 * What is wrong with the configured secret, or null when it is usable.
 * Pure: the caller passes the environment.
 */
export function sessionSecretProblem(env: Record<string, string | undefined> = process.env): SessionSecretProblem | null {
  const secret = env.LOBBYFORGE_SESSION_SECRET;
  if (!secret) return 'missing';
  if (secret.length < SESSION_SECRET_MIN_LENGTH) return 'too_short';
  if (isPlaceholderSessionSecret(secret) && !isDevStack(env)) return 'placeholder';
  return null;
}

const PROBLEM_MESSAGES: Record<SessionSecretProblem, string> = {
  missing: `LOBBYFORGE_SESSION_SECRET must be set to at least ${SESSION_SECRET_MIN_LENGTH} characters`,
  too_short: `LOBBYFORGE_SESSION_SECRET must be set to at least ${SESSION_SECRET_MIN_LENGTH} characters`,
  placeholder:
    'LOBBYFORGE_SESSION_SECRET is a published placeholder (from an example env file or the dev compose), so anyone could forge sessions. ' +
    "Generate a real one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
    `(only the local dev stack may use a placeholder, by setting ${DEV_STACK_ENV}=true).`,
};

/**
 * The configured session secret, or a thrown Error naming what is wrong.
 * Every process calls this at startup (fail closed: it refuses to run) and
 * the request paths that read the secret call it too.
 */
export function requireSessionSecret(env: Record<string, string | undefined> = process.env): string {
  const problem = sessionSecretProblem(env);
  if (problem) throw new Error(PROBLEM_MESSAGES[problem]);
  return env.LOBBYFORGE_SESSION_SECRET!;
}
