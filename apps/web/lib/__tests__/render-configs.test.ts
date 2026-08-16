/**
 * LF-010-R + LF-019 regression tests.
 *
 * LF-010-R: config rendering must be idempotent and re-runnable with a
 * NEW domain. The original bug: install.sh `sed -i` the tracked configs,
 * the first run destroyed the placeholder, and a re-run with a different
 * domain left nginx/LiveKit on the OLD domain while .env.prod carried
 * the new one.
 *
 * LF-019: the coturn TURN config renders the shared credential alongside
 * the domain, and LiveKit's rtc.turn_servers entries stay in sync with
 * turnserver.conf's static user.
 *
 * Runs the real scripts/render-configs.sh via bash against a temp
 * fixture that mirrors the infra/ layout.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const RENDER_SCRIPT = join(REPO_ROOT, 'scripts', 'render-configs.sh');
const TEMPLATES = {
  nginx: join(REPO_ROOT, 'infra', 'nginx', 'conf.d', 'app.conf.template'),
  livekit: join(REPO_ROOT, 'infra', 'livekit', 'livekit.yaml.template'),
  turn: join(REPO_ROOT, 'infra', 'turn', 'turnserver.conf.template'),
};
const TURN_SECRET = 'a'.repeat(64);

let workdir: string;

function setupInfraFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-render-'));
  mkdirSync(join(dir, 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(dir, 'livekit'), { recursive: true });
  mkdirSync(join(dir, 'turn'), { recursive: true });
  copyFileSync(TEMPLATES.nginx, join(dir, 'nginx', 'conf.d', 'app.conf.template'));
  copyFileSync(TEMPLATES.livekit, join(dir, 'livekit', 'livekit.yaml.template'));
  copyFileSync(TEMPLATES.turn, join(dir, 'turn', 'turnserver.conf.template'));
  return dir;
}

function runRender(domain: string, secret = TURN_SECRET, infraRoot = workdir): string {
  return execFileSync('bash', [RENDER_SCRIPT, domain, secret, infraRoot], { encoding: 'utf8' });
}

function read(part: 'nginx' | 'livekit' | 'turn', generated = true): string {
  const file =
    part === 'nginx'
      ? join(workdir, 'nginx', 'conf.d', generated ? 'app.conf' : 'app.conf.template')
      : part === 'livekit'
        ? join(workdir, 'livekit', generated ? 'livekit.yaml' : 'livekit.yaml.template')
        : join(workdir, 'turn', generated ? 'turnserver.conf' : 'turnserver.conf.template');
  return readFileSync(file, 'utf8');
}

beforeAll(() => {
  workdir = setupInfraFixture();
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('scripts/render-configs.sh — LF-010-R rerun safety', () => {
  it('renders all three configs with the given domain on first run', () => {
    const out = runRender('first.example.com');
    expect(out).toContain('app.conf');
    expect(out).toContain('livekit.yaml');
    expect(out).toContain('turnserver.conf');

    expect(read('nginx')).toContain('server_name first.example.com;');
    expect(read('nginx')).toContain('/etc/letsencrypt/live/first.example.com/fullchain.pem');
    for (const part of ['nginx', 'livekit', 'turn'] as const) {
      expect(read(part)).not.toContain('LOBBYFORGE_DOMAIN');
      expect(read(part)).not.toContain('TURN_CREDENTIAL');
    }
  });

  it('re-run with a DIFFERENT domain fully replaces the old one (the LF-010-R regression)', () => {
    runRender('second.example.com');

    const nginx = read('nginx');
    expect(nginx).toContain('server_name second.example.com;');
    expect(nginx).not.toContain('first.example.com');
    expect(nginx).not.toContain('LOBBYFORGE_DOMAIN');
  });

  it('never mutates the tracked templates', () => {
    const before = read('nginx', false);
    const beforeTurn = read('turn', false);
    runRender('third.example.com');
    expect(read('nginx', false)).toBe(before);
    expect(read('turn', false)).toBe(beforeTurn);
    expect(before).toContain('LOBBYFORGE_DOMAIN'); // placeholders intact
  });

  it('rejects a domain that would corrupt the sed output', () => {
    expect(() => runRender('evil/example.com')).toThrow();
    // Nothing was overwritten for the invalid domain.
    expect(read('nginx')).toContain('third.example.com');
  });

  it('fails loudly when a template is missing', () => {
    const broken = mkdtempSync(join(tmpdir(), 'lf-render-broken-'));
    try {
      mkdirSync(join(broken, 'nginx', 'conf.d'), { recursive: true });
      mkdirSync(join(broken, 'livekit'), { recursive: true });
      copyFileSync(TEMPLATES.nginx, join(broken, 'nginx', 'conf.d', 'app.conf.template'));
      copyFileSync(TEMPLATES.livekit, join(broken, 'livekit', 'livekit.yaml.template'));
      // turn template intentionally absent.
      expect(() => runRender('ok.example.com', TURN_SECRET, broken)).toThrow();
      expect(existsSync(join(broken, 'turn', 'turnserver.conf'))).toBe(false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('scripts/render-configs.sh — LF-019 TURN wiring', () => {
  it('renders the shared credential into coturn AND LiveKit turn_servers in sync', () => {
    const turn = read('turn');
    expect(turn).toContain(`user=lobbyforge:${TURN_SECRET}`);
    expect(turn).toContain('realm=third.example.com');
    expect(turn).toContain('listening-port=3478');
    expect(turn).toContain('min-port=49160');
    expect(turn).toContain('max-port=49200');

    const livekit = read('livekit');
    expect(livekit).toContain('turn_servers:');
    expect(livekit).toContain('host: third.example.com');
    expect(livekit).toContain('username: lobbyforge');
    expect(livekit).toContain(`credential: ${TURN_SECRET}`);
    // Both UDP and TCP fallbacks are advertised to clients.
    expect(livekit.match(/protocol: udp/g)).toHaveLength(1);
    expect(livekit.match(/protocol: tcp/g)).toHaveLength(1);
  });

  it('rejects a non-hex turn secret before writing anything', () => {
    // A secret with sed metacharacters / newlines would inject config syntax.
    expect(() => runRender('ok.example.com', 'z'.repeat(64))).toThrow();
    expect(() => runRender('ok.example.com', 'a\nb')).toThrow();
    expect(() => runRender('ok.example.com', 'short')).toThrow();
    // Previous render output untouched.
    expect(read('turn')).toContain(TURN_SECRET);
  });
});
