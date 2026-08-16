/**
 * LF-010-R regression tests: config rendering must be idempotent and
 * re-runnable with a NEW domain. The original bug: install.sh `sed -i`
 * the tracked configs, the first run destroyed the placeholder, and a
 * re-run with a different domain left nginx/LiveKit on the OLD domain
 * while .env.prod carried the new one.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const RENDER_SCRIPT = join(REPO_ROOT, 'scripts', 'render-configs.sh');
const TEMPLATE_NGINX = join(REPO_ROOT, 'infra', 'nginx', 'conf.d', 'app.conf.template');
const TEMPLATE_LIVEKIT = join(REPO_ROOT, 'infra', 'livekit', 'livekit.yaml.template');

let workdir: string;

function setupInfraFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-render-'));
  mkdirSync(join(dir, 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(dir, 'livekit'), { recursive: true });
  copyFileSync(TEMPLATE_NGINX, join(dir, 'nginx', 'conf.d', 'app.conf.template'));
  copyFileSync(TEMPLATE_LIVEKIT, join(dir, 'livekit', 'livekit.yaml.template'));
  return dir;
}

function runRender(domain: string, infraRoot: string): string {
  return execFileSync('bash', [RENDER_SCRIPT, domain, infraRoot], { encoding: 'utf8' });
}

beforeAll(() => {
  workdir = setupInfraFixture();
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('scripts/render-configs.sh (LF-010-R)', () => {
  it('renders both configs with the given domain on first run', () => {
    const out = runRender('first.example.com', workdir);
    expect(out).toContain('app.conf');
    expect(out).toContain('livekit.yaml');

    const nginx = readFileSync(join(workdir, 'nginx', 'conf.d', 'app.conf'), 'utf8');
    expect(nginx).toContain('server_name first.example.com;');
    expect(nginx).toContain('/etc/letsencrypt/live/first.example.com/fullchain.pem');
    expect(nginx).not.toContain('LOBBYFORGE_DOMAIN');

    const livekit = readFileSync(join(workdir, 'livekit', 'livekit.yaml'), 'utf8');
    expect(livekit).not.toContain('LOBBYFORGE_DOMAIN');
  });

  it('re-run with a DIFFERENT domain fully replaces the old one (the LF-010-R regression)', () => {
    runRender('second.example.com', workdir);

    const nginx = readFileSync(join(workdir, 'nginx', 'conf.d', 'app.conf'), 'utf8');
    expect(nginx).toContain('server_name second.example.com;');
    expect(nginx).not.toContain('first.example.com');
    expect(nginx).not.toContain('LOBBYFORGE_DOMAIN');
  });

  it('never mutates the tracked templates', () => {
    const before = readFileSync(join(workdir, 'nginx', 'conf.d', 'app.conf.template'), 'utf8');
    runRender('third.example.com', workdir);
    const after = readFileSync(join(workdir, 'nginx', 'conf.d', 'app.conf.template'), 'utf8');
    expect(after).toBe(before);
    expect(after).toContain('LOBBYFORGE_DOMAIN'); // placeholder intact
  });

  it('rejects a domain that would corrupt the sed output', () => {
    expect(() => runRender('evil/example.com', workdir)).toThrow();
    // Nothing was overwritten for the invalid domain.
    const nginx = readFileSync(join(workdir, 'nginx', 'conf.d', 'app.conf'), 'utf8');
    expect(nginx).toContain('third.example.com');
  });

  it('fails loudly when a template is missing', () => {
    const broken = mkdtempSync(join(tmpdir(), 'lf-render-broken-'));
    try {
      mkdirSync(join(broken, 'nginx', 'conf.d'), { recursive: true });
      mkdirSync(join(broken, 'livekit'), { recursive: true });
      writeFileSync(join(broken, 'nginx', 'conf.d', 'app.conf.template'), 'x');
      // livekit template intentionally absent.
      expect(() => runRender('ok.example.com', broken)).toThrow();
      expect(existsSync(join(broken, 'livekit', 'livekit.yaml'))).toBe(false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
