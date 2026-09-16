#!/usr/bin/env node
// Release manifest generator — run by the release workflow on every tag.
// Produces the release-manifest.json asset that `lfctl update check
// --manifest <url>` consumes. When an Ed25519 private key is available
// (LF_RELEASE_SIGNING_KEY env or --key-file, PEM PKCS#8) the manifest is
// signed with the SAME canonicalization lfctl verifies — the signature is
// embedded as manifest.signature (base64url). Unsigned manifests remain
// valid for clients that have not pinned a public key (lfctl reports
// signature status "not_configured"); a client WITH a pinned key fails
// closed on an unsigned manifest, which is the intended trust upgrade.
import fs from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign, verify as verifySignature } from 'node:crypto';

// MUST stay byte-identical to canonicalize() in scripts/lfctl.mjs —
// lfctl verifies the signature over exactly this serialization.
// A drift here means every published manifest fails client verification.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => key !== 'signature').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function parseArgs(argv) {
  const options = { channel: 'stable', out: 'release-manifest.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') options.version = argv[++i];
    else if (arg === '--changelog') options.changelog = argv[++i];
    else if (arg === '--channel') options.channel = argv[++i];
    else if (arg === '--minimum-version') options.minimumVersion = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--key-file') options.keyFile = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// Same section-selection rule as the release workflow's awk: the section
// for THIS version if the changelog was retitled for release, otherwise
// the newest (topmost) section.
function extractChangelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let started = false;
  let taken = false;
  for (const line of lines) {
    if (/^## \[/.test(line)) {
      if (started) break;
      if (line.includes(`v${version}`) || line.includes(`[${version}]`)) {
        started = true;
      } else if (!taken) {
        taken = true;
        started = true;
      }
    }
    if (started) out.push(line);
  }
  return out.join('\n').trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.version) {
    console.log(
      'Usage: node scripts/release-manifest.mjs --version <semver> [--changelog docs/CHANGELOG.md] ' +
        '[--channel stable] [--minimum-version <semver>] [--out release-manifest.json] [--key-file <pem>]\n' +
        'Signing key: --key-file <pem> or LF_RELEASE_SIGNING_KEY env (Ed25519 PKCS#8 PEM).'
    );
    process.exitCode = options.version ? 0 : 1;
    return;
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(options.version)) {
    throw new Error(`--version must be bare semver (no v prefix): ${options.version}`);
  }

  let releaseNotes = '';
  if (options.changelog) {
    const markdown = await fs.readFile(options.changelog, 'utf8');
    releaseNotes = extractChangelogSection(markdown, options.version);
  }

  const manifest = {
    version: options.version,
    channel: options.channel,
    releaseNotes,
  };
  if (options.minimumVersion) manifest.minimumVersion = options.minimumVersion;

  const keyPem = options.keyFile
    ? await fs.readFile(options.keyFile, 'utf8')
    : process.env.LF_RELEASE_SIGNING_KEY;
  if (keyPem && keyPem.trim()) {
    const privateKey = createPrivateKey(keyPem.trim());
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Signing key must be Ed25519, got ${privateKey.asymmetricKeyType}`);
    }
    const spkiDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    manifest.keyId = createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
    manifest.signature = sign(
      null,
      Buffer.from(canonicalize(manifest), 'utf8'),
      privateKey
    ).toString('base64url');

    // Round-trip: verify with the derived public key exactly the way
    // lfctl does — never publish a manifest that would fail verification.
    const ok = verifySignature(
      null,
      Buffer.from(canonicalize(manifest), 'utf8'),
      createPublicKey(privateKey),
      Buffer.from(manifest.signature, 'base64url')
    );
    if (!ok) throw new Error('Internal error: manifest signature failed round-trip verification.');
    console.error(`Signed release manifest (keyId ${manifest.keyId}).`);
  } else {
    console.error('No signing key configured — writing UNSIGNED manifest.');
  }

  await fs.writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`Wrote ${options.out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
