/**
 * ADR-007, infra side: the production compose file keeps the plugin
 * worker on a network only the web app joins, with its container
 * hardening intact. No YAML dependency in this package: the compose file
 * is simple enough to read by indentation, like the other compose tests
 * (apps/web/lib/__tests__/turn-relay-auth.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = readFileSync(join(__dirname, '..', '..', '..', '..', 'infra', 'docker', 'docker-compose.prod.yml'), 'utf8').replace(
  /\r\n/g,
  '\n'
);

/** Top-level section body (`services:`, `networks:`, ...). */
function section(name: string): string {
  const lines = COMPOSE.split('\n');
  const start = lines.indexOf(`${name}:`);
  expect(start, `top-level ${name}:`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z]/i.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** Two-space-indented blocks of a section, by key. */
function blocks(sectionBody: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of sectionBody.split('\n')) {
    const key = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (key) {
      if (current) out.set(current, buf.join('\n'));
      current = key[1]!;
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) out.set(current, buf.join('\n'));
  return out;
}

/** The `networks:` list of a service block (comments skipped). */
function serviceNetworks(block: string): string[] {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /^ {4}networks:\s*$/.test(l));
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const item = /^ {6}- ([\w-]+)\s*$/.exec(line);
    if (!item) break;
    names.push(item[1]!);
  }
  return names;
}

const services = blocks(section('services'));
const networks = blocks(section('networks'));

describe('docker-compose.prod.yml — the plugin worker (ADR-007)', () => {
  const worker = services.get('plugin-worker') ?? '';

  it('the worker sits ONLY on the plugin-sandbox network', () => {
    expect(worker).not.toBe('');
    expect(serviceNetworks(worker)).toEqual(['plugin-sandbox']);
  });

  it('web is the only other service on plugin-sandbox', () => {
    const members = [...services.entries()].filter(([, block]) => serviceNetworks(block).includes('plugin-sandbox')).map(([name]) => name);
    expect(members.sort()).toEqual(['plugin-worker', 'web']);
    // web keeps its own networks too.
    expect(serviceNetworks(services.get('web') ?? '')).toEqual(expect.arrayContaining(['edge', 'internal', 'plugin-sandbox']));
  });

  it('plugin-sandbox is an internal network (no route out)', () => {
    const net = networks.get('plugin-sandbox') ?? '';
    expect(net).toMatch(/^ {4}internal: true\b/m);
    expect(net).toMatch(/^ {4}name: lobbyforge-plugin-sandbox\s*$/m);
  });

  it('the worker keeps its hardening', () => {
    expect(worker).toMatch(/^ {4}read_only: true\s*$/m);
    expect(worker).toMatch(/^ {4}mem_limit: \d+m\s*$/m);
    expect(worker).toMatch(/^ {4}pids_limit: \d+\s*$/m);
    expect(worker).toMatch(/^ {4}cap_drop:\n {6}- ALL\s*$/m);
    expect(worker).toMatch(/- no-new-privileges:true/);
    expect(worker).toMatch(/- plugins-data:\/app\/plugins:ro/);
  });

  it('the worker gets no secrets beyond its RPC token, and nothing to call back', () => {
    expect(worker).not.toMatch(/env_file/);
    expect(worker).not.toMatch(/PLUGIN_HOST_ORIGIN/);
    expect(worker).not.toMatch(/STORAGE_TOKEN/);
    expect(worker).not.toMatch(/DATABASE_URL|REDIS_URL|LF_DB_URL|SESSION_SECRET|LIVEKIT/);
    expect(worker).toMatch(/PLUGIN_WORKER_TOKEN: \$\{LOBBYFORGE_PLUGIN_WORKER_TOKEN:\?/);
    expect(worker).not.toMatch(/^ {4}ports:/m);
  });

  it('web still reaches the worker by name', () => {
    expect(services.get('web') ?? '').toContain('LOBBYFORGE_PLUGIN_WORKER_URL=http://plugin-worker:7101');
  });
});
