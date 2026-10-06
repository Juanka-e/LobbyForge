#!/usr/bin/env node
// Refresh the vendored disposable-email domain list (docs/EMAIL.md §4.5).
//
//   node scripts/update-disposable-domains.mjs            fetch the latest list
//   node scripts/update-disposable-domains.mjs --ref <sha> fetch a given commit
//   node scripts/update-disposable-domains.mjs --check    exit 1 if the file is malformed
//
// Source: https://github.com/disposable-email-domains/disposable-email-domains
// (`disposable_email_blocklist.conf`), released under CC0-1.0 — compatible
// with LobbyForge's AGPL-3.0. The list is curated by hand (additions need
// evidence), which keeps false positives low; local exceptions belong in
// Admin → Email (allow / block lists), never in the vendored file.
//
// Writes apps/web/lib/mail/disposable-domains.json with a header (source
// URL pinned to the commit, the commit, the date, the licence) and the
// domains sorted and de-duplicated. Review the diff before committing.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'disposable-email-domains/disposable-email-domains';
const FILE = 'disposable_email_blocklist.conf';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'apps', 'web', 'lib', 'mail', 'disposable-domains.json');
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
// A sanity floor: a truncated download must not silently empty the list.
const MIN_DOMAINS = 1000;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function parse(text) {
  const domains = new Set();
  const rejected = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (DOMAIN.test(line)) domains.add(line);
    else rejected.push(line);
  }
  return { domains: [...domains].sort(), rejected };
}

function check() {
  const data = JSON.parse(readFileSync(TARGET, 'utf8'));
  const problems = [];
  if (!Array.isArray(data.domains)) problems.push('domains is not an array');
  else {
    if (data.domains.length < MIN_DOMAINS) problems.push(`only ${data.domains.length} domains`);
    if (data.count !== data.domains.length) problems.push('count does not match');
    const bad = data.domains.filter((d) => typeof d !== 'string' || !DOMAIN.test(d));
    if (bad.length) problems.push(`${bad.length} malformed entries, e.g. ${JSON.stringify(bad[0])}`);
    const sorted = [...data.domains].sort();
    if (sorted.some((d, i) => d !== data.domains[i])) problems.push('not sorted');
    if (new Set(data.domains).size !== data.domains.length) problems.push('duplicates');
  }
  for (const key of ['source', 'commit', 'fetchedAt', 'license']) if (!data[key]) problems.push(`missing ${key}`);
  if (problems.length) {
    console.error(`✖ ${TARGET}:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✔ ${data.count} domains from ${data.commit.slice(0, 12)} (${data.fetchedAt})`);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lobbyforge-update-disposable-domains', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function update() {
  const ref = option('ref');
  const commit = ref ?? (await fetchJson(`https://api.github.com/repos/${REPO}/commits/HEAD`)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit id ${JSON.stringify(commit)}`);
  const source = `https://raw.githubusercontent.com/${REPO}/${commit}/${FILE}`;
  const res = await fetch(source, { headers: { 'User-Agent': 'lobbyforge-update-disposable-domains' } });
  if (!res.ok) throw new Error(`${source} → HTTP ${res.status}`);
  const { domains, rejected } = parse(await res.text());
  if (domains.length < MIN_DOMAINS) throw new Error(`only ${domains.length} domains parsed — refusing to write a truncated list`);
  if (rejected.length) console.warn(`skipped ${rejected.length} malformed line(s), e.g. ${JSON.stringify(rejected[0])}`);

  let previous = null;
  try {
    previous = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    /* first run */
  }
  const data = {
    _comment:
      'Vendored disposable-email domain list (docs/EMAIL.md §4.5). Source: github.com/disposable-email-domains/disposable-email-domains, ' +
      'file disposable_email_blocklist.conf, CC0-1.0. Do not edit by hand: refresh with `node scripts/update-disposable-domains.mjs`; ' +
      'local exceptions go in Admin → Email (allow / block lists).',
    source,
    commit,
    fetchedAt: new Date().toISOString().slice(0, 10),
    license: 'CC0-1.0',
    count: domains.length,
    domains,
  };
  writeFileSync(TARGET, `${JSON.stringify(data, null, 1)}\n`);
  if (previous?.domains) {
    const before = new Set(previous.domains);
    const after = new Set(domains);
    const added = domains.filter((d) => !before.has(d)).length;
    const removed = previous.domains.filter((d) => !after.has(d)).length;
    console.log(`✔ ${domains.length} domains (${commit.slice(0, 12)}): +${added} −${removed}`);
  } else {
    console.log(`✔ ${domains.length} domains (${commit.slice(0, 12)})`);
  }
}

if (args.includes('--check')) check();
else
  update().catch((error) => {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  });
