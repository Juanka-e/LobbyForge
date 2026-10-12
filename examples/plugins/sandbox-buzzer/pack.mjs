#!/usr/bin/env node
/**
 * Pack a `sdk: "sandbox-v1"` marketplace bundle into the tarball the
 * LobbyForge installer expects, plus its SHA-256 (the value the instance
 * owner's approval pins).
 *
 *   node pack.mjs [bundleDir] [--out <dir>]
 *
 * bundleDir defaults to this script's folder; --out defaults to
 * <bundleDir>/dist. Writes <id>-<version>.tgz and <id>-<version>.tgz.sha256
 * and prints a JSON summary.
 *
 * What goes in: manifest.json, server.js and, when present, ui/ (regular
 * files only) and locales/ (`<language code>.json` files only). Entries
 * are `./manifest.json`, `./server.js`, `./locales/...`, `./ui/...`: the
 * installer extracts with `--strip-components=1`, so they land at the
 * bundle root. The archive is reproducible on a given Node version: sorted
 * entries, mtime 0, uid/gid 0, fixed modes, gzip without a timestamp.
 *
 * No dependencies: a minimal POSIX ustar writer and node:zlib.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// The installer's limits (apps/web/lib/plugin-installer.ts).
const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_SERVER_JS_BYTES = 2 * 1024 * 1024;
// The installer's locale-table limits (apps/web/lib/sandbox-manifest.ts),
// checked here so a mistake shows up when you pack, not when the owner installs.
const MAX_LOCALE_FILES = 32;
const MAX_LOCALE_FILE_BYTES = 128 * 1024;
const LOCALE_FILE_RE = /^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/;

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let dir = dirname(fileURLToPath(import.meta.url));
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else dir = argv[i];
  }
  dir = resolve(dir);
  return { dir, out: resolve(out ?? join(dir, 'dist')) };
}

/** ustar numeric field: zero-padded octal, NUL-terminated. */
function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(path, size, isDir) {
  const block = Buffer.alloc(512, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', 154);
    if (cut <= 0) fail(`path too long for ustar: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) fail(`path too long for ustar: ${path}`);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(octal(isDir ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii'); // uid
  block.write(octal(0, 8), 116, 8, 'ascii'); // gid
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii'); // mtime
  block.fill(0x20, 148, 156); // checksum placeholder: spaces
  block.write(isDir ? '5' : '0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

function collectUi(dir, rel, files) {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const childRel = `${rel}/${name}`;
    const stat = lstatSync(join(dir, childRel));
    if (stat.isSymbolicLink()) fail(`${childRel} is a symlink; the installer refuses links`);
    if (stat.isDirectory()) {
      files.push({ path: `${childRel}/`, dir: true });
      collectUi(dir, childRel, files);
    } else if (stat.isFile()) {
      files.push({ path: childRel, dir: false });
    } else {
      fail(`${childRel} is not a regular file`);
    }
  }
}

/**
 * locales/: one flat `{ "key": "text" }` table per language, named by its
 * code (`tr.json`, `pt-BR.json`). The installer re-checks everything (key
 * names, lengths, `catalog.name` / `catalog.summary` caps); this catches
 * the common mistakes.
 */
function collectLocales(dir, manifest) {
  const localesDir = join(dir, 'locales');
  if (!existsSync(localesDir)) return [];
  if (!lstatSync(localesDir).isDirectory()) fail('locales must be a folder');
  const names = readdirSync(localesDir).sort();
  if (names.length > MAX_LOCALE_FILES) fail(`locales/ has more than ${MAX_LOCALE_FILES} files`);
  const codes = [];
  for (const name of names) {
    const stat = lstatSync(join(localesDir, name));
    const match = LOCALE_FILE_RE.exec(name);
    if (!stat.isFile() || !match) fail(`locales/${name}: only <language code>.json files may sit in locales/ (e.g. tr.json, pt-BR.json)`);
    if (stat.size > MAX_LOCALE_FILE_BYTES) fail(`locales/${name} is larger than ${MAX_LOCALE_FILE_BYTES} bytes`);
    let table;
    try {
      table = JSON.parse(readFileSync(join(localesDir, name), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      fail(`locales/${name} is not valid JSON`);
    }
    if (!table || typeof table !== 'object' || Array.isArray(table)) fail(`locales/${name} must be a JSON object of "key": "text" pairs`);
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string') fail(`locales/${name}: "${key}" must be a string`);
    }
    codes.push(match[1]);
  }
  if (Array.isArray(manifest.locales) && codes.length > 0) {
    const same = manifest.locales.length === codes.length && manifest.locales.every((code) => codes.includes(code));
    if (!same) fail(`manifest.json "locales" (${manifest.locales.join(', ')}) must list exactly the languages in locales/ (${codes.join(', ')}), or be left out`);
  }
  return names.map((name) => ({ path: `locales/${name}`, dir: false }));
}

function main() {
  const { dir, out } = parseArgs(process.argv.slice(2));
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`no manifest.json in ${dir}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('manifest.json is not valid JSON');
  }
  if (manifest.sdk !== 'sandbox-v1') fail('manifest.json: "sdk" must be "sandbox-v1"');
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(manifest.id)) fail('manifest.json: invalid "id"');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i.test(manifest.version)) {
    fail('manifest.json: "version" must be strict semver');
  }
  if (typeof manifest.ui !== 'boolean') fail('manifest.json: "ui" must be true or false');
  const serverPath = join(dir, 'server.js');
  if (!existsSync(serverPath)) fail(`no server.js in ${dir}`);
  if (readFileSync(serverPath).length > MAX_SERVER_JS_BYTES) fail(`server.js is larger than ${MAX_SERVER_JS_BYTES} bytes`);
  const hasUi = existsSync(join(dir, 'ui'));
  if (manifest.ui && !existsSync(join(dir, 'ui', 'index.html'))) fail('manifest.json says "ui": true but ui/index.html is missing');

  const files = [
    { path: 'manifest.json', dir: false },
    { path: 'server.js', dir: false },
  ];
  const locales = collectLocales(dir, manifest);
  if (locales.length > 0) files.push({ path: 'locales/', dir: true }, ...locales);
  if (hasUi) {
    files.push({ path: 'ui/', dir: true });
    collectUi(dir, 'ui', files);
  }
  if (files.length + 1 > MAX_ENTRIES) fail(`more than ${MAX_ENTRIES} entries`);

  const blocks = [header('./', 0, true)];
  let unpacked = 0;
  for (const file of files) {
    if (file.dir) {
      blocks.push(header(`./${file.path}`, 0, true));
      continue;
    }
    const content = readFileSync(join(dir, ...file.path.split('/')));
    unpacked += content.length;
    if (unpacked > MAX_UNPACKED_BYTES) fail(`more than ${MAX_UNPACKED_BYTES} bytes unpacked`);
    blocks.push(header(`./${file.path}`, content.length, false), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  gz[9] = 0xff; // gzip OS field: "unknown", so the bytes do not depend on the build platform
  if (gz.length > MAX_COMPRESSED_BYTES) fail(`the tarball is larger than ${MAX_COMPRESSED_BYTES} bytes`);

  const sha256 = createHash('sha256').update(gz).digest('hex');
  const fileName = `${manifest.id}-${manifest.version}.tgz`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, fileName), gz);
  writeFileSync(join(out, `${fileName}.sha256`), `${sha256}  ${fileName}\n`);
  console.info(
    JSON.stringify(
      { file: join(out, fileName), sha256, sizeBytes: gz.length, entries: files.map((f) => `./${f.path}`) },
      null,
      2
    )
  );
}

main();
