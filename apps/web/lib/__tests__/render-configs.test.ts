/**
 * LF-010-R + LF-019 regression tests.
 *
 * LF-010-R: config rendering must be idempotent and re-runnable with a
 * NEW domain. The original bug: install.sh `sed -i` the tracked configs,
 * the first run destroyed the placeholder, and a re-run with a different
 * domain left nginx/LiveKit on the OLD domain while .env.prod carried
 * the new one.
 *
 * LF-019 + VOICE-001: the coturn TURN config renders in REST-auth mode
 * (use-auth-secret + static-auth-secret) and LiveKit's config contains
 * NO static turn_servers credential — the web app mints per-user,
 * time-limited credentials instead (lib/turn-credentials.ts).
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

function runRender(
  domain: string,
  secret = TURN_SECRET,
  infraRoot = workdir,
  env: Record<string, string> = {}
): string {
  return execFileSync('bash', [RENDER_SCRIPT, domain, secret, infraRoot], {
    encoding: 'utf8',
    // The webhook key is opt-in per call — never inherited from the shell.
    env: { ...process.env, LIVEKIT_WEBHOOK_API_KEY: '', ...env },
  });
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
      expect(read(part)).not.toContain('TURN_SECRET');
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

describe('rendered nginx — V5-001 LiveKit prefix strip', () => {
  it('forwards /livekit/rtc to the upstream as /rtc (trailing slash is load-bearing)', () => {
    const nginx = read('nginx');
    // The location must be /livekit/ (not /livekit — that would also
    // match /livekitfoo) and the proxy_pass URI part must strip it.
    expect(nginx).toContain('location /livekit/ {');
    expect(nginx).toContain('proxy_pass http://livekit:7880/;');
    // The prefix-preserving form is the regression this test pins:
    // proxy_pass WITHOUT a trailing slash forwards /livekit/rtc as-is,
    // which LiveKit (serving /rtc, /rtc/validate) 404s — killing every
    // production voice connection behind the proxy.
    expect(nginx).not.toMatch(/location \/livekit\/ \{[^}]*proxy_pass http:\/\/livekit:7880;/s);
    // nginx URI-part semantics, simulated: replace the matched location
    // prefix with the proxy_pass URI.
    const mapUpstream = (path: string) =>
      path.replace(/^\/livekit\//, '/').replace(/^\/livekit$/, '/');
    expect(mapUpstream('/livekit/rtc/v1')).toBe('/rtc/v1');
    expect(mapUpstream('/livekit/rtc')).toBe('/rtc');
    expect(mapUpstream('/livekit/rtc/validate')).toBe('/rtc/validate');
  });

  it('V5-005: does not expose LiveKit HTTP signaling publicly', () => {
    const compose = readFileSync(join(REPO_ROOT, 'infra', 'docker', 'docker-compose.prod.yml'), 'utf8');
    // The livekit service may publish 7881 (ICE/TCP) and the UDP media
    // range, but 7880 (plaintext HTTP signaling) must stay internal —
    // nginx is the only TLS terminator.
    // Anchor to the SERVICE key at column 0 — nginx's depends_on now
    // also mentions `livekit:` (indented), which the loose pattern
    // would match first.
    const livekitSection = compose.match(/^  livekit:[\s\S]*?(?=^  \w[\w-]*:)/m)?.[0] ?? '';
    expect(livekitSection).not.toMatch(/["']7880:7880["']/);
    expect(livekitSection).toMatch(/["']7881:7881["']/);
  });
});

describe('scripts/render-configs.sh — LF-019 + VOICE-001 TURN wiring', () => {
  it('renders coturn in REST-auth mode and NEVER ships a static credential', () => {
    const turn = read('turn');
    expect(turn).toContain('use-auth-secret');
    expect(turn).toContain(`static-auth-secret=${TURN_SECRET}`);
    expect(turn).toContain('realm=third.example.com');
    expect(turn).toContain('listening-port=3478');
    expect(turn).toContain('min-port=49160');
    expect(turn).toContain('max-port=49200');
    // VOICE-001: the static shared user is GONE — every member used to
    // receive this permanent credential via LiveKit's connect response.
    expect(turn).not.toContain('user=lobbyforge');
    expect(turn).not.toContain('user-quota=64'); // per-user quota restored

    // LiveKit must not advertise static turn_servers — the web app mints
    // per-user ephemeral credentials instead (see lib/turn-credentials).
    const livekit = read('livekit');
    expect(livekit).not.toContain('turn_servers:');
    expect(livekit).not.toContain(`credential: ${TURN_SECRET}`);
    expect(livekit).not.toContain('username: lobbyforge');
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

describe('scripts/render-configs.sh — LiveKit webhook (AUTHZ-006 follow-up)', () => {
  const WEBHOOK_URL = 'http://web:3000/api/livekit/webhook';

  it('without LIVEKIT_WEBHOOK_API_KEY, renders the webhook block commented out (old flows unchanged)', () => {
    runRender('hook.example.com');
    const livekit = read('livekit');
    expect(livekit).not.toContain('@LIVEKIT_WEBHOOK');
    expect(livekit).toMatch(/^webhook:\n  # api_key: disabled[^\n]*\n  # urls: \[[^\n]*\]$/m);
    // No live (uncommented) webhook keys anywhere.
    expect(livekit).not.toMatch(/^\s*api_key:/m);
    expect(livekit).not.toMatch(/^\s*urls:/m);
  });

  it('with LIVEKIT_WEBHOOK_API_KEY, names that key and posts to the web service', () => {
    runRender('hook.example.com', TURN_SECRET, workdir, { LIVEKIT_WEBHOOK_API_KEY: 'devkey_0123456789abcdef' });
    const livekit = read('livekit');
    expect(livekit).not.toContain('@LIVEKIT_WEBHOOK');
    expect(livekit).toContain(
      `\nwebhook:\n  api_key: devkey_0123456789abcdef\n  urls: ["${WEBHOOK_URL}"]\n`
    );
    // Exactly one live api_key / urls entry — the webhook block's.
    expect(livekit.match(/^\s*api_key:/gm)).toHaveLength(1);
    expect(livekit.match(/^\s*urls:/gm)).toHaveLength(1);
  });

  it('rejects a key that could inject YAML, before writing anything', () => {
    runRender('hook.example.com', TURN_SECRET, workdir, { LIVEKIT_WEBHOOK_API_KEY: 'goodkey' });
    for (const bad of ['bad key', 'key: x', 'key\nurls: []', 'key"', 'a'.repeat(129)]) {
      expect(() => runRender('hook.example.com', TURN_SECRET, workdir, { LIVEKIT_WEBHOOK_API_KEY: bad })).toThrow();
    }
    expect(read('livekit')).toContain('  api_key: goodkey\n');
  });

  it('nginx refuses the webhook path at the public edge', () => {
    const nginx = read('nginx');
    expect(nginx).toMatch(/location \^~ \/api\/livekit\/webhook \{\s*return 404;\s*\}/);
  });
});
