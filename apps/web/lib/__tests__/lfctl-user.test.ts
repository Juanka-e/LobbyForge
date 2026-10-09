/**
 * `lfctl user reset-password` / `lfctl user list-admins` — the REAL CLI,
 * driven with a fake `docker` (the lfctl-update-recovery technique).
 *
 *   - a password is NEVER taken on the command line (and never echoed back
 *     when someone tries), nor ever put in docker's argv: it reaches the
 *     web container on stdin only;
 *   - the sign-up policy is checked before anything runs in the container
 *     (MIN_PASSWORD_LENGTH is imported from the app, so lfctl's twin stays
 *     pinned to it);
 *   - a missing install, a stopped stack and an image without the command
 *     are explained, with non-zero exit codes; nothing runs in a container
 *     before the request is valid;
 *   - the container's answers become messages and exit codes (2 refused,
 *     3 password changed but sessions still live).
 *
 * The fake logs every docker invocation (argv) and what `exec` got on
 * stdin; `exec` answers with FAKE_EXEC_STDOUT / FAKE_EXEC_STDERR /
 * FAKE_EXEC_RC.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const LFCTL = join(REPO_ROOT, 'scripts', 'lfctl.mjs');
/** The sign-up cap (`/api/auth/register`, `MAX_PASSWORD_LENGTH` in lib/operator-accounts.ts). */
const MAX_PASSWORD_LENGTH = 128;
const SECRET = 'hunter2-hunter2-secret';

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" ps -q web "*)
    [ -n "$FAKE_WEB_CONTAINER" ] && echo "$FAKE_WEB_CONTAINER"
    exit "\${FAKE_PS_RC:-0}"
    ;;
  *" exec -T web "*)
    cat > "$FAKE_STDIN_LOG"
    [ -n "$FAKE_EXEC_STDERR" ] && printf '%s\\n' "$FAKE_EXEC_STDERR" >&2
    [ -n "$FAKE_EXEC_STDOUT" ] && printf '%s\\n' "$FAKE_EXEC_STDOUT"
    exit "\${FAKE_EXEC_RC:-0}"
    ;;
esac
exit 0
`;

interface Sandbox {
  dir: string;
  dockerLog: string;
  stdinLog: string;
  fakeDocker: string;
}

const sandboxes: Sandbox[] = [];

function makeSandbox(opts: { install?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'lf-user-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const fakeDocker = join(dir, 'bin', 'docker-fake');
  writeFileSync(fakeDocker, FAKE_DOCKER.replace(/\r\n/g, '\n'), { mode: 0o755 });
  chmodSync(fakeDocker, 0o755);
  if (opts.install !== false) writeFileSync(join(dir, '.env.prod'), 'NODE_ENV=production\n');
  const sandbox = { dir, dockerLog: join(dir, 'docker-calls.log'), stdinLog: join(dir, 'exec-stdin.log'), fakeDocker };
  sandboxes.push(sandbox);
  return sandbox;
}

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox.dir, { recursive: true, force: true });
});

interface RunOptions {
  input?: string;
  webContainer?: string;
  psRc?: number;
  execStdout?: string;
  execStderr?: string;
  execRc?: number;
}

function lfctl(sandbox: Sandbox, args: string[], opts: RunOptions = {}) {
  const res = spawnSync(process.execPath, [LFCTL, ...args], {
    cwd: sandbox.dir,
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // lfctl resolves .env.prod and the compose file from LFCTL_ROOT.
      LFCTL_ROOT: sandbox.dir,
      // execFile/spawn cannot run a POSIX script on Windows: launch via bash.
      LFCTL_DOCKER: `bash ${sandbox.fakeDocker.replace(/\\/g, '/')}`,
      FAKE_DOCKER_LOG: sandbox.dockerLog,
      FAKE_STDIN_LOG: sandbox.stdinLog,
      FAKE_WEB_CONTAINER: opts.webContainer ?? 'fake-web-container',
      FAKE_PS_RC: String(opts.psRc ?? 0),
      FAKE_EXEC_STDOUT: opts.execStdout ?? '',
      FAKE_EXEC_STDERR: opts.execStderr ?? '',
      FAKE_EXEC_RC: String(opts.execRc ?? 0),
    },
  });
  return { rc: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', out: (res.stdout ?? '') + (res.stderr ?? '') };
}

function dockerCalls(sandbox: Sandbox): string[] {
  return existsSync(sandbox.dockerLog) ? readFileSync(sandbox.dockerLog, 'utf8').split('\n').filter(Boolean) : [];
}

function execCalls(sandbox: Sandbox): string[] {
  return dockerCalls(sandbox).filter((call) => call.includes(' exec -T web '));
}

function sentRequest(sandbox: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(sandbox.stdinLog, 'utf8'));
}

const RESET_OK = JSON.stringify({ ok: true, action: 'reset-password', email: 'owner@example.test', displayName: 'Ada', sessionsRevoked: 2 });

describe('lfctl user reset-password — the password never rides on the command line', () => {
  it.each([
    [['--password', SECRET]],
    [[`--password=${SECRET}`]],
    [['--new-password', SECRET]],
    [['-p', SECRET]],
    [['--pw', SECRET]],
    [[`--password-stdin=${SECRET}`]],
  ])('refuses %j without echoing it or touching docker', (extra) => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', ...extra]);
    expect(rc, out).toBe(1);
    expect(out).toContain('never takes a password on the command line');
    expect(out).not.toContain(SECRET);
    expect(dockerCalls(sandbox)).toEqual([]);
  });

  it('refuses a stray positional value (a password typed in the wrong place) without echoing it', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', SECRET]);
    expect(rc, out).toBe(1);
    expect(out).toContain('not shown');
    expect(out).not.toContain(SECRET);
    expect(dockerCalls(sandbox)).toEqual([]);
  });

  it('sends the password on stdin only: never in any docker argv', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'Owner@Example.TEST', '--password-stdin'], {
      input: `${SECRET}\n`,
      execStdout: RESET_OK,
    });
    expect(rc, out).toBe(0);
    expect(dockerCalls(sandbox).some((call) => call.includes(SECRET))).toBe(false);
    expect(sentRequest(sandbox)).toEqual({ action: 'reset-password', email: 'owner@example.test', password: SECRET });
    // The app's own code, inside the running web container of THIS install.
    const [exec] = execCalls(sandbox);
    expect(exec).toContain(`compose -f ${join(sandbox.dir, 'infra', 'docker', 'docker-compose.prod.yml')} --env-file ${join(sandbox.dir, '.env.prod')}`);
    expect(exec).toMatch(/ exec -T web node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/operator-user\.mjs$/);
    expect(out).toContain('Password reset for owner@example.test (Ada).');
    expect(out).toContain('2 session(s) revoked');
    expect(out).not.toContain(SECRET);
  });
});

describe('lfctl user reset-password — arguments and the sign-up policy', () => {
  it('requires --email, and an email address', () => {
    const sandbox = makeSandbox();
    const missing = lfctl(sandbox, ['user', 'reset-password', '--generate']);
    expect(missing.rc, missing.out).toBe(1);
    expect(missing.out).toContain('requires --email');
    expect(missing.out).toContain('list-admins');
    const bad = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner', '--generate']);
    expect(bad.rc, bad.out).toBe(1);
    expect(bad.out).toContain('is not an email address');
    expect(dockerCalls(sandbox)).toEqual([]);
  });

  it('takes --password-stdin or --generate, not both, and needs one of them without a terminal', () => {
    const sandbox = makeSandbox();
    const both = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin', '--generate']);
    expect(both.rc, both.out).toBe(1);
    expect(both.out).toContain('not both');
    // spawnSync gives lfctl a pipe, not a terminal: there is nobody to prompt.
    const none = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test']);
    expect(none.rc, none.out).toBe(1);
    expect(none.out).toContain('No terminal');
    expect(none.out).toContain('--password-stdin');
    expect(dockerCalls(sandbox)).toEqual([]);
  });

  it(`refuses a password shorter than ${MIN_PASSWORD_LENGTH} or longer than ${MAX_PASSWORD_LENGTH} before the container runs`, () => {
    const sandbox = makeSandbox();
    for (const password of ['x'.repeat(MIN_PASSWORD_LENGTH - 1), 'x'.repeat(MAX_PASSWORD_LENGTH + 1)]) {
      const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin'], {
        input: `${password}\n`,
        execStdout: RESET_OK,
      });
      expect(rc, out).toBe(1);
      expect(out).toMatch(new RegExp(`at (least ${MIN_PASSWORD_LENGTH}|most ${MAX_PASSWORD_LENGTH}) characters`));
      expect(out).toContain('Nothing was changed');
    }
    expect(execCalls(sandbox)).toEqual([]);
  });

  it(`accepts exactly ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters; a CRLF line ending is not part of the password`, () => {
    for (const password of ['y'.repeat(MIN_PASSWORD_LENGTH), 'z'.repeat(MAX_PASSWORD_LENGTH)]) {
      const sandbox = makeSandbox();
      const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin'], {
        input: `${password}\r\n`,
        execStdout: RESET_OK,
      });
      expect(rc, out).toBe(0);
      expect(sentRequest(sandbox).password).toBe(password);
    }
  });

  it('refuses empty or multi-line stdin', () => {
    const sandbox = makeSandbox();
    for (const input of ['', '\n', `${SECRET}\nsecond line\n`]) {
      const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin'], { input });
      expect(rc, out).toBe(1);
      expect(out).toMatch(/nothing was piped in|exactly one line/);
      expect(out).not.toContain(SECRET);
    }
    expect(execCalls(sandbox)).toEqual([]);
  });

  it('--generate makes a strong password, sends it on stdin and prints it once, after the reset succeeded', () => {
    const shape = /^[a-km-zA-HJ-NP-Z2-9]{6}(-[a-km-zA-HJ-NP-Z2-9]{6}){3}$/;
    const seen = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const sandbox = makeSandbox();
      const { rc, stdout, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--generate'], {
        execStdout: RESET_OK,
      });
      expect(rc, out).toBe(0);
      const sent = String(sentRequest(sandbox).password);
      expect(sent).toMatch(shape);
      expect(sent.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      expect(stdout.split(sent).length - 1).toBe(1); // printed exactly once
      expect(dockerCalls(sandbox).some((call) => call.includes(sent))).toBe(false);
      seen.add(sent);
    }
    expect(seen.size).toBe(2);
  });

  it('--json: the generated password is in the answer; a piped one never is', () => {
    const generated = makeSandbox();
    const gen = lfctl(generated, ['user', 'reset-password', '--email', 'owner@example.test', '--generate', '--json'], { execStdout: RESET_OK });
    expect(gen.rc, gen.out).toBe(0);
    const genBody = JSON.parse(gen.stdout);
    expect(genBody).toMatchObject({ reset: true, email: 'owner@example.test', displayName: 'Ada', sessionsRevoked: 2 });
    expect(genBody.password).toBe(sentRequest(generated).password);

    const piped = makeSandbox();
    const pipe = lfctl(piped, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin', '--json'], {
      input: SECRET,
      execStdout: RESET_OK,
    });
    expect(pipe.rc, pipe.out).toBe(0);
    expect(JSON.parse(pipe.stdout)).toEqual({ reset: true, email: 'owner@example.test', displayName: 'Ada', sessionsRevoked: 2 });
    expect(pipe.out).not.toContain(SECRET);
  });
});

describe('lfctl user — install, stack and image problems', () => {
  it('no install (.env.prod missing): exit 2 before docker is asked anything', () => {
    const sandbox = makeSandbox({ install: false });
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--password-stdin'], { input: SECRET });
    expect(rc, out).toBe(2);
    expect(out).toContain('No LobbyForge install found');
    expect(out).toContain('.env.prod');
    expect(dockerCalls(sandbox)).toEqual([]);
    const list = lfctl(sandbox, ['user', 'list-admins']);
    expect(list.rc, list.out).toBe(2);
    expect(list.out).toContain('No LobbyForge install found');
  });

  it('web container not running: exit 2 with the start command, nothing executed', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--generate'], { webContainer: '' });
    expect(rc, out).toBe(2);
    expect(out).toContain('The web container is not running');
    expect(out).toContain('up -d --wait');
    expect(execCalls(sandbox)).toEqual([]);
    expect(out).not.toMatch(/New password/);
  });

  it('docker compose itself failing: exit 2 with its message', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'list-admins'], { psRc: 1 });
    expect(rc, out).toBe(2);
    expect(out).toContain('Could not ask Docker about the web container');
  });

  it('an image from before this command: says to update, exit 2', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'list-admins'], {
      execStderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/apps/web/scripts/operator-user.mjs'",
      execRc: 1,
    });
    expect(rc, out).toBe(2);
    expect(out).toContain('does not have the account recovery command yet');
    expect(out).toContain('update apply');
  });

  it('a crash inside the container: exit 2 with the last stderr line', () => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--generate'], {
      execStderr: '[operator] connect ECONNREFUSED postgres:5432',
      execRc: 1,
    });
    expect(rc, out).toBe(2);
    expect(out).toContain('failed inside the web container (exit 1)');
    expect(out).toContain('ECONNREFUSED');
    expect(out).not.toMatch(/New password/);
  });
});

describe("lfctl user reset-password — the container's answers", () => {
  it.each([
    ['unknown_email', 'No account uses owner@example.test'],
    ['deleted_account', 'was deleted'],
    ['guest_account', 'guest account'],
    ['weak_password', `at least ${MIN_PASSWORD_LENGTH} characters`],
  ])('%s: exit 2, explained, no password printed', (error, message) => {
    const sandbox = makeSandbox();
    const { rc, out } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--generate'], {
      execStdout: JSON.stringify({ ok: false, error }),
      execRc: 2,
    });
    expect(rc, out).toBe(2);
    expect(out).toContain(message);
    expect(out).not.toContain(String(sentRequest(sandbox).password));
  });

  it('password changed but sessions not revoked: exit 3, a warning, and the generated password still shown', () => {
    const sandbox = makeSandbox();
    const { rc, stdout, stderr } = lfctl(sandbox, ['user', 'reset-password', '--email', 'owner@example.test', '--generate'], {
      execStdout: JSON.stringify({ ok: true, action: 'reset-password', email: 'owner@example.test', displayName: 'Ada', sessionsRevoked: null, warning: 'sessions_not_revoked' }),
      execRc: 3,
    });
    expect(rc, stdout + stderr).toBe(3);
    expect(stderr).toContain('the password WAS changed');
    expect(stdout).toContain(String(sentRequest(sandbox).password));
  });
});

describe('lfctl user list-admins', () => {
  const ACCOUNTS = [
    { email: 'owner@example.test', displayName: 'Ada', instanceOwner: true, ownedServers: ['Home'] },
    { email: 'mod@example.test', displayName: 'Bob\u001b[31m‮', instanceOwner: false, ownedServers: ['Side'] },
  ];

  it('prints the owner and server owners, with terminal control characters neutralised', () => {
    const sandbox = makeSandbox();
    const { rc, stdout, out } = lfctl(sandbox, ['user', 'list-admins'], {
      execStdout: JSON.stringify({ ok: true, action: 'list-admins', accounts: ACCOUNTS }),
    });
    expect(rc, out).toBe(0);
    expect(sentRequest(sandbox)).toEqual({ action: 'list-admins' });
    const lines = stdout.trim().split('\n');
    expect(lines[1]).toMatch(/owner@example\.test\s+Ada\s+\(instance owner; owns Home\)/);
    expect(lines[2]).toMatch(/mod@example\.test\s+Bob\?\[31m\?\s+\(owns Side\)/);
    expect(stdout).not.toContain('\u001b');
    expect(stdout).not.toContain('‮');
  });

  it('--json, and the empty instance', () => {
    const sandbox = makeSandbox();
    const json = lfctl(sandbox, ['user', 'list-admins', '--json'], {
      execStdout: JSON.stringify({ ok: true, action: 'list-admins', accounts: ACCOUNTS }),
    });
    expect(json.rc, json.out).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ accounts: ACCOUNTS });

    const empty = lfctl(sandbox, ['user', 'list-admins'], { execStdout: JSON.stringify({ ok: true, action: 'list-admins', accounts: [] }) });
    expect(empty.rc, empty.out).toBe(0);
    expect(empty.stdout).toContain('No owner or admin accounts yet');
  });

  it('takes no --email, and unknown user actions are refused', () => {
    const sandbox = makeSandbox();
    const withEmail = lfctl(sandbox, ['user', 'list-admins', '--email', 'owner@example.test']);
    expect(withEmail.rc, withEmail.out).toBe(1);
    const unknown = lfctl(sandbox, ['user', 'delete']);
    expect(unknown.rc, unknown.out).toBe(1);
    expect(unknown.out).toContain('Unknown user action: delete');
    expect(dockerCalls(sandbox)).toEqual([]);
  });

  it('is in the usage text', () => {
    const sandbox = makeSandbox();
    const { rc, stdout } = lfctl(sandbox, ['--help']);
    expect(rc).toBe(0);
    expect(stdout).toContain('user reset-password --email <address> [--password-stdin | --generate]');
    expect(stdout).toContain('user list-admins');
  });
});
