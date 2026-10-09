#!/usr/bin/env node
/**
 * Code signing for the desktop installers: one place that decides what gets
 * signed, used by .github/workflows/desktop-release.yml and on the owner's
 * machine. Owner guide: docs/DESKTOP_SIGNING.md.
 *
 * Signing switches on by itself when the secrets exist and stays off
 * otherwise: with no secrets, builds are unsigned and green. A HALF-configured
 * provider (an e-mail without its TOTP seed, a certificate without its
 * password) fails the build instead, because a silently unsigned release is
 * the outcome the owner configured secrets to avoid.
 *
 * Secret VALUES are never printed, only which variable names are set.
 *
 *   plan     CI. Reads the environment, writes the Tauri signing config and
 *            the step outputs (GITHUB_OUTPUT).
 *              --platform windows|macos|linux  --version <x.y.z[-pre]>
 *              [--release-ref]  [--ssign <path>]  [--out-config <file>]
 *   prepatch-exe <src> <dest>
 *            SignPath only. Copies the app exe with the bundle-type marker
 *            the Tauri bundler would write already in place, so the bundler
 *            leaves the signed file alone (see prepatchBundleType).
 *   local    Release-day fallback on a Windows machine: builds the NSIS
 *            installer signed with Certum (ssign + a one-time code from the
 *            SimplySign app) or a certificate in the Windows store.
 *              [--version <x.y.z>]  [--thumbprint <sha1>]  [--ssign <path>]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const tauriDir = join(desktopRoot, 'src-tauri');

export const CERTUM_TIMESTAMP_URL = 'http://time.certum.pl';
export const SIGNATURE_NAME = 'LobbyForge';
export const SIGNATURE_URL = 'https://lobbyforge.org';

/** The bundler's placeholder and the NSIS value it patches in (tauri-bundler src/bundle.rs). */
export const BUNDLE_TYPE_PLACEHOLDER = '__TAURI_BUNDLE_TYPE_VAR_UNK';
export const BUNDLE_TYPE_NSIS = '__TAURI_BUNDLE_TYPE_VAR_NSS';

const has = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * Decides what a build signs. Pure: environment in, plan out.
 *
 * Windows providers (configure exactly one):
 *   certum    CERTUM_EMAIL + CERTUM_OTP (the TOTP seed from SimplySign's QR
 *             code). Signed by ssign over HTTPS during `tauri bundle`.
 *   signpath  SIGNPATH_API_TOKEN + SIGNPATH_ORGANIZATION_ID. Signed by
 *             SignPath's GitHub action after the build (two requests: app exe,
 *             then installers). Release refs use SIGNPATH_POLICY_SLUG
 *             (default release-signing); other runs only sign when
 *             SIGNPATH_TEST_POLICY_SLUG is set.
 * macOS: APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD sign; adding either
 *   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID or APPLE_API_ISSUER +
 *   APPLE_API_KEY + APPLE_API_PRIVATE_KEY also notarizes.
 */
export function planSigning(env, { platform, version, releaseRef = false, ssignPath = 'ssign' }) {
  if (!['windows', 'macos', 'linux'].includes(platform)) {
    throw new Error(`unknown platform "${platform}"`);
  }
  const errors = [];
  const notes = [];
  const plan = {
    platform,
    windows: 'none',
    macos: 'none',
    bundles: '',
    tauriConfig: null,
    expectSignature: 'none',
    signpathPolicy: '',
    notes,
    errors,
  };
  const prerelease = /-/.test(String(version ?? ''));

  if (platform === 'windows') {
    const certum = ['CERTUM_EMAIL', 'CERTUM_OTP'];
    const signpath = ['SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID'];
    const certumSet = certum.filter((n) => has(env, n));
    const signpathSet = signpath.filter((n) => has(env, n));
    if (certumSet.length > 0 && certumSet.length < certum.length) {
      errors.push(`Certum signing is half-configured: ${certumSet.join(', ')} set, ${certum.filter((n) => !certumSet.includes(n)).join(', ')} missing.`);
    }
    if (signpathSet.length > 0 && signpathSet.length < signpath.length) {
      errors.push(`SignPath signing is half-configured: ${signpathSet.join(', ')} set, ${signpath.filter((n) => !signpathSet.includes(n)).join(', ')} missing.`);
    }
    const certumReady = certumSet.length === certum.length;
    const signpathReady = signpathSet.length === signpath.length;
    if (certumReady && signpathReady) {
      errors.push('Both Certum and SignPath are configured. SmartScreen reputation belongs to one signing identity: keep the secrets of one provider and delete the other.');
    } else if (certumReady) {
      plan.windows = 'certum';
      plan.expectSignature = 'trusted';
      plan.tauriConfig = {
        bundle: {
          windows: {
            signCommand: {
              cmd: ssignPath,
              args: ['--name', SIGNATURE_NAME, '--url', SIGNATURE_URL, '%1'],
            },
          },
        },
      };
    } else if (signpathReady) {
      const policy = releaseRef
        ? env.SIGNPATH_POLICY_SLUG?.trim() || 'release-signing'
        : env.SIGNPATH_TEST_POLICY_SLUG?.trim() || '';
      if (policy) {
        plan.windows = 'signpath';
        plan.signpathPolicy = policy;
        plan.expectSignature = releaseRef ? 'trusted' : 'present';
      } else {
        notes.push('SignPath is configured, but this is not a release tag and SIGNPATH_TEST_POLICY_SLUG is unset: this build stays unsigned (each release-signing request needs a manual approval).');
      }
    }

    // MSI: WiX rejects pre-release versions ("rc.2" must be numeric), and
    // ssign cannot sign MSI files yet, so a Certum build ships the NSIS
    // installer alone rather than an unsigned MSI next to a signed EXE.
    const msi = !prerelease && plan.windows !== 'certum';
    if (!prerelease && plan.windows === 'certum') {
      notes.push('No MSI in this build: ssign signs PE files (the NSIS installer and everything in it) but not MSI.');
    }
    plan.bundles = msi ? 'nsis,msi' : 'nsis';
  }

  if (platform === 'macos') {
    const cert = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'];
    const appleId = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
    const apiKey = ['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_PRIVATE_KEY'];
    const count = (names) => names.filter((n) => has(env, n));
    const certSet = count(cert);
    const appleIdSet = count(appleId);
    const apiKeySet = count(apiKey);
    for (const [label, names, set] of [
      ['Developer ID certificate', cert, certSet],
      ['Apple ID notarization', appleId, appleIdSet],
      ['App Store Connect API notarization', apiKey, apiKeySet],
    ]) {
      if (set.length > 0 && set.length < names.length) {
        errors.push(`${label} is half-configured: ${set.join(', ')} set, ${names.filter((n) => !set.includes(n)).join(', ')} missing.`);
      }
    }
    const signing = certSet.length === cert.length;
    const notarizing = appleIdSet.length === appleId.length || apiKeySet.length === apiKey.length;
    if (notarizing && !signing) {
      errors.push('Notarization credentials are set without a Developer ID certificate (APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD); Apple only notarizes signed apps.');
    } else if (signing) {
      plan.macos = notarizing ? 'notarize' : 'sign';
      plan.expectSignature = 'trusted';
      if (!notarizing) {
        notes.push('macOS app is signed but not notarized: Gatekeeper still blocks it on first open. Add Apple ID or API key notarization secrets.');
      }
    }
  }

  return plan;
}

/**
 * The Tauri bundler writes the package type into the main exe right before
 * bundling (it replaces BUNDLE_TYPE_PLACEHOLDER), and then signs the exe if
 * it can. With SignPath the exe is signed BEFORE bundling, and that patch
 * would break the signature. Writing the NSIS value first means the bundler
 * finds no placeholder, logs a warning and leaves the signed file as it is.
 * The value is what an NSIS build gets anyway; the updater, which reads it,
 * is not used.
 */
export function prepatchBundleType(buffer) {
  const placeholder = Buffer.from(BUNDLE_TYPE_PLACEHOLDER, 'latin1');
  const index = buffer.indexOf(placeholder);
  if (index === -1) {
    if (buffer.includes(Buffer.from(BUNDLE_TYPE_NSIS, 'latin1'))) return buffer; // already done
    throw new Error(`${BUNDLE_TYPE_PLACEHOLDER} not found: is this a Tauri app binary?`);
  }
  const out = Buffer.from(buffer);
  Buffer.from(BUNDLE_TYPE_NSIS, 'latin1').copy(out, index);
  return out;
}

export function describePlan(plan) {
  const lines = [];
  if (plan.platform === 'windows') {
    const label = {
      none: 'off (unsigned build)',
      certum: 'Certum SimplySign via ssign (CERTUM_EMAIL, CERTUM_OTP)',
      signpath: `SignPath, policy "${plan.signpathPolicy}" (SIGNPATH_API_TOKEN, SIGNPATH_ORGANIZATION_ID)`,
    }[plan.windows];
    lines.push(`Windows signing: ${label}`);
    lines.push(`Windows bundles: ${plan.bundles}`);
  } else if (plan.platform === 'macos') {
    lines.push(`macOS signing: ${{ none: 'off (unsigned build)', sign: 'Developer ID, not notarized', notarize: 'Developer ID + notarization' }[plan.macos]}`);
  } else {
    lines.push('Linux: no OS-level signing (SHA256 checksums are published with the release).');
  }
  for (const note of plan.notes) lines.push(`note: ${note}`);
  return lines;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
  else console.info(`[output] ${key}=${value}`);
}

function runPlan(args) {
  const platform = argValue(args, '--platform');
  const plan = planSigning(process.env, {
    platform,
    version: argValue(args, '--version') ?? '',
    releaseRef: args.includes('--release-ref'),
    ssignPath: argValue(args, '--ssign') ?? 'ssign',
  });
  for (const line of describePlan(plan)) console.info(line);
  if (plan.errors.length > 0) {
    for (const error of plan.errors) console.info(`::error::${error}`);
    process.exit(1);
  }
  let configPath = '';
  if (plan.tauriConfig) {
    configPath = resolve(argValue(args, '--out-config') ?? join(tmpdir(), 'tauri.signing.conf.json'));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(plan.tauriConfig, null, 2)}\n`);
  }
  setOutput('windows-signing', plan.windows);
  setOutput('macos-signing', plan.macos);
  setOutput('bundles', plan.bundles);
  setOutput('config', configPath);
  setOutput('expect-signature', plan.expectSignature);
  setOutput('signpath-policy', plan.signpathPolicy);
}

function runPrepatch(args) {
  const [src, dest] = args;
  if (!src || !dest) throw new Error('usage: prepatch-exe <src> <dest>');
  mkdirSync(dirname(resolve(dest)), { recursive: true });
  writeFileSync(dest, prepatchBundleType(readFileSync(src)));
  console.info(`prepatched ${basename(src)} -> ${dest}`);
}

/**
 * pnpm is a .cmd shim on Windows, which Node only starts through a shell, so
 * those arguments are quoted here. Executables run without a shell.
 */
function run(cmd, cmdArgs, { shell = false, env } = {}) {
  const quoted = shell ? cmdArgs.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)) : cmdArgs;
  console.info(`> ${cmd} ${quoted.join(' ')}`);
  const result = spawnSync(cmd, quoted, { stdio: 'inherit', shell, env: env ?? process.env });
  if (result.status !== 0) throw new Error(`${cmd} exited with ${result.status ?? result.error?.message}`);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Release-day signing on the owner's Windows machine. */
async function runLocal(args) {
  if (process.platform !== 'win32') throw new Error('local signing builds the Windows installer: run it on Windows');
  const version = argValue(args, '--version');
  const thumbprint = argValue(args, '--thumbprint')?.replace(/\s/g, '');
  const tauri = ['--filter', '@lobbyforge/desktop', 'exec', 'tauri'];
  const workDir = join(tauriDir, 'target', 'release', 'signed-release');
  mkdirSync(workDir, { recursive: true });
  // The release version goes into the binary and the installer, like the
  // "Inject release version" step in CI, without editing tauri.conf.json.
  const versionConfig = [];
  if (version) {
    const versionPath = join(workDir, 'tauri.version.conf.json');
    writeFileSync(versionPath, `${JSON.stringify({ version })}\n`);
    versionConfig.push('--config', versionPath);
  }

  let signingConfig;
  if (thumbprint) {
    // Certificate in the Windows store: SimplySign Desktop logged in, or a token.
    signingConfig = {
      bundle: {
        windows: {
          certificateThumbprint: thumbprint,
          digestAlgorithm: 'sha256',
          timestampUrl: CERTUM_TIMESTAMP_URL,
          tsp: true,
        },
      },
    };
  } else {
    const ssign = argValue(args, '--ssign') ?? 'ssign';
    signingConfig = planSigning(
      { CERTUM_EMAIL: 'set', CERTUM_OTP: 'set' },
      { platform: 'windows', version: version ?? '', ssignPath: ssign },
    ).tauriConfig;
  }
  const configPath = join(workDir, 'tauri.signing.conf.json');
  writeFileSync(configPath, `${JSON.stringify(signingConfig, null, 2)}\n`);

  // 1. Compile first: it takes minutes, and a SimplySign code lasts 30 s.
  run('pnpm', [...tauri, 'build', '--no-bundle', ...versionConfig], { shell: true });

  // 2. Ask for the code only now. ssign keeps the session for 20 minutes, so
  //    one code signs the app, the uninstaller and the installer.
  const env = { ...process.env };
  if (!thumbprint) {
    if (!has(env, 'CERTUM_EMAIL')) env.CERTUM_EMAIL = await ask('Certum account e-mail: ');
    if (!has(env, 'CERTUM_OTP') && !has(env, 'CERTUM_TOKEN')) {
      env.CERTUM_TOKEN = await ask('Current 6-digit code from the SimplySign app: ');
    }
  }
  run('pnpm', [...tauri, 'bundle', '--bundles', 'nsis', '--config', configPath, ...versionConfig], { shell: true, env });

  // 3. Verify, then stage the files under the names the release uses.
  const nsisDir = join(tauriDir, 'target', 'release', 'bundle', 'nsis');
  const installers = readdirSync(nsisDir).filter((f) => f.endsWith('-setup.exe') && (!version || f.includes(`_${version}_`)));
  if (installers.length === 0) throw new Error(`no installer in ${nsisDir}`);
  for (const file of installers) {
    const src = join(nsisDir, file);
    run('powershell', [
      '-NoProfile',
      '-Command',
      `$s = Get-AuthenticodeSignature -LiteralPath '${src.replaceAll("'", "''")}'; "{0}: {1}, signed by {2}" -f $s.Path, $s.Status, $s.SignerCertificate.Subject; if ($s.Status -ne 'Valid') { exit 1 }`,
    ]);
    const asset = `desktop-windows-${file}`;
    copyFileSync(src, join(workDir, asset));
    const sum = createHash('sha256').update(readFileSync(src)).digest('hex');
    writeFileSync(join(workDir, `${asset}.sha256`), `${sum}  ${asset}\n`);
    console.info(`\nstaged ${join(workDir, asset)}\nsha256  ${sum}`);
  }
  console.info(`
Replace the unsigned assets of the GitHub release (tag v${version ?? '<version>'}):
  gh release upload v${version ?? '<version>'} "${workDir}\\desktop-windows-*" --clobber
Then put the new sha256 line(s) above into SHA256SUMS.txt of that release:
  gh release download v${version ?? '<version>'} --pattern SHA256SUMS.txt --clobber
  (edit the desktop-windows line, then)  gh release upload v${version ?? '<version>'} SHA256SUMS.txt --clobber`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'plan') runPlan(args);
    else if (command === 'prepatch-exe') runPrepatch(args);
    else if (command === 'local') await runLocal(args);
    else {
      console.error('usage: release-signing.mjs plan|prepatch-exe|local … (see the header of this file)');
      process.exit(2);
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
