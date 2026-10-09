#!/usr/bin/env node
/**
 * The in-container half of `lfctl user …` (scripts/lfctl.mjs; docs in
 * docs/GUEST_AUTH.md "Account recovery by the server operator"). lfctl runs
 *
 *   docker compose exec -T web node --experimental-strip-types \
 *     --disable-warning=ExperimentalWarning scripts/operator-user.mjs
 *
 * and writes ONE JSON request to stdin:
 *
 *   { "action": "list-admins" }
 *   { "action": "reset-password", "email": "…", "password": "…" }
 *
 * The password travels on stdin only, never in argv (argv shows in `ps` and
 * in shell history). The answer is ONE JSON line on stdout. Exit code: 0
 * done, 2 refused (unknown email, weak password, …), 3 password changed but
 * the sessions could not be revoked, 1 crashed (the reason on stderr).
 *
 * The work happens in lib/operator-accounts.ts, the app's own TypeScript
 * modules loaded through Node's type stripping, with the container's
 * environment (DATABASE_URL, REDIS_URL, LOBBYFORGE_SESSION_SECRET).
 * `--self-check` only loads them and exits (the tests use it).
 */
import { register } from 'node:module';
import process from 'node:process';

// Before the first import of the app's sources (they are imported
// dynamically below, after the hooks are in place).
register('./operator-user-hooks.mjs', import.meta.url);

const MAX_REQUEST_BYTES = 16 * 1024;

function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error(`request larger than ${MAX_REQUEST_BYTES} bytes`));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function finish(body, code) {
  // Exit once the line is written: the Redis and Postgres clients would
  // otherwise keep the process alive.
  process.stdout.write(`${JSON.stringify(body)}\n`, () => process.exit(code));
}

async function main() {
  const operator = await import('../lib/operator-accounts.ts');
  if (process.argv.includes('--self-check')) {
    finish({ ok: true, selfCheck: true, minLength: operator.MIN_PASSWORD_LENGTH, maxLength: operator.MAX_PASSWORD_LENGTH }, 0);
    return;
  }
  let request;
  try {
    request = JSON.parse(await readRequest());
  } catch {
    finish({ ok: false, error: 'invalid_request' }, 2);
    return;
  }
  const response = await operator.runOperatorRequest(request);
  finish(response, operator.operatorExitCode(response));
}

main().catch((error) => {
  console.error(`[operator] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
