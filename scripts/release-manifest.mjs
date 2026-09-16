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
    else if (arg === '--git-sha') options.gitSha = argv[++i];
    else if (arg === '--image-digest') options.imageDigest = argv[++i];
    else if (arg === '--allow-unsigned') options.allowUnsigned = true;
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
        '[--channel stable] [--minimum-version <semver>] [--git-sha <sha>] [--image-digest <ref@sha256:...>] ' +
        '[--out release-manifest.json] [--key-file <pem>] [--allow-unsigned]\n' +
      'Signing key: --key-file <pem> or LF_RELEASE_SIGNING_KEY env (Ed25519 PKCS#8 PEM).\n' +
      'Signing is fail-closed: without a key the script errors unless --allow-unsigned.'
    );
    process.exitCode = options.version ? 0 : 1;
    return;
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(options.version)) {
    throw new Error(`--version must be bare semver (no v prefix): ${options.version}`);
  }
  // 21st-audit: the manifest binds version -> git SHA -> immutable image
  // digest. lfctl deploys exactly this digest, making the signed manifest
  // a statement about the DEPLOYED BYTES, not just a version number.
  if (options.gitSha && !/^[0-9a-f]{40}$/i.test(options.gitSha)) {
    throw new Error(`--git-sha must be a 40-hex commit SHA: ${options.gitSha}`);
  }
  if (options.imageDigest && !/^[\w.\-/]+@sha256:[a-f0-9]{64}$/i.test(options.imageDigest)) {
    throw new Error(`--image-digest must be <image-ref>@sha256:<64hex>: ${options.imageDigest}`);
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
  if (options.gitSha) manifest.gitSha = options.gitSha;
  if (options.imageDigest) manifest.imageDigest = options.imageDigest;

  const keyPem = options.keyFile
    ? await fs.readFile(options.keyFile, 'utf8')
    : process.env.LF_RELEASE_SIGNING_KEY;
  // 21st-audit: signing is FAIL-CLOSED. A release whose signing key is
  // missing (secret deleted, renamed, wrong environment) must break the
  // build — an unsigned manifest slipping out would silently downgrade
  // every pinning client's trust guarantee. --allow-unsigned is the
  // explicit escape hatch for local testing only.
  if (!keyPem || !keyPem.trim()) {
    if (!options.allowUnsigned) {
      throw new Error(
        'No signing key configured (LF_RELEASE_SIGNING_KEY / --key-file) — refusing to write an unsigned manifest. Pass --allow-unsigned only for local testing.'
      );
    }
    console.error('Writing UNSIGNED manifest (--allow-unsigned).');
  } else {
    // 22nd-audit: a SIGNATURE must vouch for the exact deployed bytes —
    // signing a bare version number is deployable trust theater.
    if (!options.gitSha || !options.imageDigest) {
      throw new Error(
        'Signed manifests must pin --git-sha and --image-digest — without them the signature vouches for nothing deployable.'
      );
    }
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
  }

  await fs.writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`Wrote ${options.out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
