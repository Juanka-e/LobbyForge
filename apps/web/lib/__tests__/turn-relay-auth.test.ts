/**
 * security-review INFRA-001: every install.sh deployment ran coturn as an
 * OPEN relay. The installer writes turnserver.conf under `umask 077`
 * (0600, root-owned) and the coturn image runs as nobody:nogroup, so
 * coturn could not read its config and fell back to its defaults —
 * anonymous access, no denied-peer-ip rules. Nothing noticed: voice kept
 * working and the TCP healthcheck passed.
 *
 * Guards:
 *   - compose starts the container as root, the config drops to nobody
 *     via proc-user/proc-group after initialisation;
 *   - cert-watcher.sh refuses to exec turnserver when the config is
 *     unreadable or lacks REST auth (crash-loop instead of open relay);
 *   - scripts/turn-auth-probe.mjs classifies a server's answer to an
 *     unauthenticated Allocate (CI runs it against the pinned image).
 */
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const COMPOSE = readFileSync(join(REPO_ROOT, 'infra', 'docker', 'docker-compose.prod.yml'), 'utf8');
const TEMPLATE = readFileSync(join(REPO_ROOT, 'infra', 'turn', 'turnserver.conf.template'), 'utf8');
const WATCHER = join(REPO_ROOT, 'infra', 'turn', 'cert-watcher.sh');

interface ProbeModule {
  buildAllocateRequest(transactionId: Buffer): Buffer;
  classifyResponse(msg: Buffer, transactionId: Buffer): string | null;
  probeTurn(host: string, port: number, opts?: { attempts?: number; timeoutMs?: number }): Promise<string>;
}

async function loadProbe(): Promise<ProbeModule> {
  const url = new URL(`file:///${join(REPO_ROOT, 'scripts', 'turn-auth-probe.mjs').replace(/\\/g, '/')}`);
  return (await import(/* @vite-ignore */ url.href)) as ProbeModule;
}

function turnServiceBlock(): string {
  const start = COMPOSE.indexOf('\n  turn:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = COMPOSE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\nvolumes:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function stunResponse(type: number, transactionId: Buffer, errorCode?: number): Buffer {
  const attrs: Buffer[] = [];
  if (errorCode !== undefined) {
    const attr = Buffer.alloc(8);
    attr.writeUInt16BE(0x0009, 0);
    attr.writeUInt16BE(4, 2);
    attr.writeUInt8(Math.floor(errorCode / 100), 6);
    attr.writeUInt8(errorCode % 100, 7);
    attrs.push(attr);
  }
  const body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(0x2112a442, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

describe('coturn configuration (INFRA-001)', () => {
  it('starts the container as root and lets coturn drop to nobody after init', () => {
    const block = turnServiceBlock();
    expect(block).toMatch(/\n {4}user: "0:0"\n/);
    expect(block).toContain('entrypoint: ["/bin/sh", "/usr/local/bin/cert-watcher.sh"]');
    // Root is only for reading the config and dropping privileges.
    expect(block).toContain('cap_drop: [ALL]');
    expect(block).toContain('cap_add: [SETUID, SETGID, DAC_READ_SEARCH, KILL, NET_BIND_SERVICE]');
    expect(block).toContain('no-new-privileges:true');
    expect(TEMPLATE).toMatch(/^proc-user=nobody$/m);
    expect(TEMPLATE).toMatch(/^proc-group=nogroup$/m);
  });

  it('keeps REST auth, TCP relays off and the private ranges denied', () => {
    expect(TEMPLATE).toMatch(/^use-auth-secret$/m);
    expect(TEMPLATE).toMatch(/^static-auth-secret=TURN_SECRET$/m);
    expect(TEMPLATE).toMatch(/^no-tcp-relay$/m);
    for (const range of ['10.0.0.0-10.255.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255', '169.254.0.0-169.254.255.255']) {
      expect(TEMPLATE).toContain(`denied-peer-ip=${range}`);
    }
  });
});

describe('cert-watcher.sh fails closed (INFRA-001)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-turn-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runWatcher(conf: string) {
    return spawnSync('sh', [WATCHER], {
      env: { ...process.env, TURN_CONFIG: conf, CERT_DIR: join(dir, 'no-certs') },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  it('refuses to start when the config cannot be read', () => {
    const result = runWatcher(join(dir, 'missing.conf'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to start an unauthenticated relay');
  });

  it('refuses to start when the config has no REST auth', () => {
    const conf = join(dir, 'noauth.conf');
    writeFileSync(conf, 'listening-port=3478\nrealm=example.com\n');
    const result = runWatcher(conf);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not configure REST auth');
  });

  it('refuses an empty static-auth-secret', () => {
    const conf = join(dir, 'empty-secret.conf');
    writeFileSync(conf, 'use-auth-secret\nstatic-auth-secret=\n');
    const result = runWatcher(conf);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not configure REST auth');
  });
});

describe('turn-auth-probe (INFRA-001)', () => {
  it('builds an RFC 5766 Allocate request asking for a UDP relay', async () => {
    const { buildAllocateRequest } = await loadProbe();
    const tid = Buffer.alloc(12, 7);
    const msg = buildAllocateRequest(tid);
    expect(msg.readUInt16BE(0)).toBe(0x0003);
    expect(msg.readUInt16BE(2)).toBe(8);
    expect(msg.readUInt32BE(4)).toBe(0x2112a442);
    expect(msg.subarray(8, 20).equals(tid)).toBe(true);
    expect(msg.readUInt16BE(20)).toBe(0x0019);
    expect(msg.readUInt8(24)).toBe(17);
  });

  it('classifies 401, success, other errors and foreign transactions', async () => {
    const { classifyResponse } = await loadProbe();
    const tid = Buffer.alloc(12, 1);
    expect(classifyResponse(stunResponse(0x0113, tid, 401), tid)).toBe('unauthorized');
    expect(classifyResponse(stunResponse(0x0103, tid), tid)).toBe('open');
    expect(classifyResponse(stunResponse(0x0113, tid, 437), tid)).toBe('error:437');
    expect(classifyResponse(stunResponse(0x0113, Buffer.alloc(12, 2), 401), tid)).toBeNull();
    expect(classifyResponse(Buffer.alloc(4), tid)).toBeNull();
  });

  async function withFakeServer(reply: (req: Buffer) => Buffer, run: (port: number) => Promise<void>) {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => server.send(reply(msg), rinfo.port, rinfo.address));
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    try {
      await run(server.address().port);
    } finally {
      server.close();
    }
  }

  it('reports an enforcing server as unauthorized', async () => {
    const { probeTurn } = await loadProbe();
    await withFakeServer(
      (req) => stunResponse(0x0113, req.subarray(8, 20), 401),
      async (port) => expect(await probeTurn('127.0.0.1', port, { attempts: 2, timeoutMs: 500 })).toBe('unauthorized')
    );
  });

  it('reports an anonymous server as an open relay', async () => {
    const { probeTurn } = await loadProbe();
    await withFakeServer(
      (req) => stunResponse(0x0103, req.subarray(8, 20)),
      async (port) => expect(await probeTurn('127.0.0.1', port, { attempts: 2, timeoutMs: 500 })).toBe('open')
    );
  });
});
