/**
 * Windows installer and code-signing wiring (docs/DESKTOP_SIGNING.md).
 *
 * The NSIS template is a copy of Tauri's, so it must be rebased whenever the
 * Tauri CLI changes: the first test fails on a CLI upgrade until someone does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_TYPE_NSIS,
  BUNDLE_TYPE_PLACEHOLDER,
  planSigning,
  prepatchBundleType,
} from '../../scripts/release-signing.mjs';

const root = join(__dirname, '..', '..');
const tauriDir = join(root, 'src-tauri');
const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')) as {
  productName: string;
  bundle: {
    publisher: string;
    copyright?: string;
    homepage?: string;
    windows: {
      certificateThumbprint?: string;
      signCommand?: unknown;
      nsis: Record<string, unknown>;
      wix: Record<string, string>;
    };
  };
};
const nsis = conf.bundle.windows.nsis;
const template = readFileSync(join(tauriDir, String(nsis.template)), 'utf8');

function bmpInfo(path: string) {
  const b = readFileSync(join(tauriDir, path));
  return {
    magic: b.toString('latin1', 0, 2),
    width: b.readInt32LE(18),
    height: b.readInt32LE(22),
    bpp: b.readUInt16LE(28),
  };
}

describe('NSIS template', () => {
  it('is based on the installed Tauri CLI (rebase it on every CLI upgrade)', () => {
    const cli = JSON.parse(
      readFileSync(join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), 'utf8')
    ) as { version: string };
    const base = /TAURI_TEMPLATE_BASE: @tauri-apps\/cli (\S+)/.exec(template)?.[1];
    expect(base, 'see "Upgrading Tauri" in docs/DESKTOP_SIGNING.md').toBe(cli.version);
  });

  it('keeps every LobbyForge change fenced', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(template).toContain(`LOBBYFORGE (${n}/4)`);
    }
  });

  it('is one-click by default, launches the app and keeps the wizard behind /WIZARD', () => {
    expect(template).toMatch(/GetOptions\} \$CMDLINE "\/WIZARD"/);
    expect(template).toMatch(/StrCpy \$OneClickMode 1/);
    expect(template).toMatch(/\$\{ElseIf\} \$OneClickMode = 1\s+nsis_tauri_utils::RunAsUser/);
  });

  it('shows only the heading and the bar in passive mode, not per-file detail lines', () => {
    const macro = /!macro LOBBYFORGE_COMPACT_PROGRESS([\s\S]*?)!macroend/.exec(template)?.[1] ?? '';
    expect(macro).toMatch(/^\s*\$\{If\} \$PassiveMode = 1/);
    expect(macro).toContain('ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}');
    // The wizard keeps Tauri's status line: nothing outside the passive-only
    // macro touches it.
    expect(template.replace(macro, '')).not.toContain('$mui.InstFilesPage.Text');
  });
});

describe('installer configuration', () => {
  it('installs per user without an admin prompt', () => {
    expect(nsis.installMode).toBe('currentUser');
    expect(template).toContain('RequestExecutionLevel user');
  });

  it('offers English and Turkish, picked from the system language', () => {
    expect(nsis.languages).toEqual(['English', 'Turkish']);
    expect(nsis.displayLanguageSelector).toBe(false);
  });

  it('names a publisher that is not the product name (Microsoft Store rule)', () => {
    expect(conf.bundle.publisher).toBeTruthy();
    expect(conf.bundle.publisher).not.toBe(conf.productName);
    expect(conf.bundle.copyright).toContain(conf.bundle.publisher);
    expect(conf.bundle.homepage).toMatch(/^https:\/\//);
  });

  it('ships the artwork in the sizes NSIS and WiX expect', () => {
    const expected: Array<[string, number, number]> = [
      [String(nsis.headerImage), 150, 57],
      [String(nsis.sidebarImage), 164, 314],
      [String(nsis.uninstallerHeaderImage), 150, 57],
      [conf.bundle.windows.wix.bannerPath, 493, 58],
      [conf.bundle.windows.wix.dialogImagePath, 493, 312],
    ];
    for (const [path, width, height] of expected) {
      expect(bmpInfo(path), path).toEqual({ magic: 'BM', width, height, bpp: 24 });
    }
    const ico = readFileSync(join(tauriDir, String(nsis.installerIcon)));
    expect(ico.readUInt16LE(2)).toBe(1); // icon
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });

  it('keeps signing out of the committed config (CI adds it only when secrets exist)', () => {
    expect(conf.bundle.windows.certificateThumbprint).toBeUndefined();
    expect(conf.bundle.windows.signCommand).toBeUndefined();
  });
});

describe('planSigning', () => {
  const certum = { CERTUM_EMAIL: 'owner@example.com', CERTUM_OTP: 'JBSWY3DPEHPK3PXP' };
  const signpath = { SIGNPATH_API_TOKEN: 'token-value', SIGNPATH_ORGANIZATION_ID: 'org-id' };

  it('builds unsigned, with MSI only for plain versions, when no secrets exist', () => {
    const stable = planSigning({}, { platform: 'windows', version: '0.3.0' });
    expect(stable).toMatchObject({ windows: 'none', bundles: 'nsis,msi', tauriConfig: null, errors: [] });
    const rc = planSigning({ CERTUM_EMAIL: ' ' }, { platform: 'windows', version: '0.3.0-rc.1' });
    expect(rc).toMatchObject({ windows: 'none', bundles: 'nsis', errors: [] });
    expect(planSigning({}, { platform: 'macos', version: '0.3.0' }).macos).toBe('none');
  });

  it('signs with ssign for Certum, without putting secrets in the config', () => {
    const plan = planSigning(certum, { platform: 'windows', version: '0.3.0', ssignPath: 'C:/t/ssign.exe' });
    expect(plan.windows).toBe('certum');
    expect(plan.bundles).toBe('nsis');
    expect(plan.tauriConfig?.bundle.windows.signCommand).toEqual({
      cmd: 'C:/t/ssign.exe',
      args: ['--name', 'LobbyForge', '--url', 'https://lobbyforge.org', '%1'],
    });
    const json = JSON.stringify(plan);
    expect(json).not.toContain(certum.CERTUM_OTP);
    expect(json).not.toContain(certum.CERTUM_EMAIL);
  });

  it('fails a half-configured or doubly configured Windows setup', () => {
    expect(planSigning({ CERTUM_EMAIL: 'a@b.c' }, { platform: 'windows' }).errors[0]).toMatch(/CERTUM_OTP missing/);
    expect(planSigning({ SIGNPATH_API_TOKEN: 'x' }, { platform: 'windows' }).errors[0]).toMatch(/SIGNPATH_ORGANIZATION_ID/);
    expect(planSigning({ ...certum, ...signpath }, { platform: 'windows' }).errors[0]).toMatch(/Both Certum and SignPath/);
  });

  it('uses SignPath release signing on release tags and test signing only when configured', () => {
    const release = planSigning(signpath, { platform: 'windows', version: '1.0.0', releaseRef: true });
    expect(release).toMatchObject({ windows: 'signpath', signpathPolicy: 'release-signing', expectSignature: 'trusted', bundles: 'nsis,msi' });
    expect(planSigning(signpath, { platform: 'windows', version: '1.0.0' }).windows).toBe('none');
    const test = planSigning({ ...signpath, SIGNPATH_TEST_POLICY_SLUG: 'test-signing' }, { platform: 'windows' });
    expect(test).toMatchObject({ windows: 'signpath', signpathPolicy: 'test-signing', expectSignature: 'present' });
  });

  it('signs and notarizes macOS only with complete Apple credentials', () => {
    const cert = { APPLE_CERTIFICATE: 'base64', APPLE_CERTIFICATE_PASSWORD: 'pw' };
    expect(planSigning(cert, { platform: 'macos' }).macos).toBe('sign');
    const appleId = { APPLE_ID: 'id', APPLE_PASSWORD: 'app-pw', APPLE_TEAM_ID: 'TEAM' };
    expect(planSigning({ ...cert, ...appleId }, { platform: 'macos' }).macos).toBe('notarize');
    const api = { APPLE_API_ISSUER: 'i', APPLE_API_KEY: 'k', APPLE_API_PRIVATE_KEY: 'p8' };
    expect(planSigning({ ...cert, ...api }, { platform: 'macos' }).macos).toBe('notarize');
    expect(planSigning(appleId, { platform: 'macos' }).errors[0]).toMatch(/without a Developer ID certificate/);
    expect(planSigning({ APPLE_CERTIFICATE: 'x' }, { platform: 'macos' }).errors[0]).toMatch(/half-configured/);
  });

  it('ignores Windows and Apple secrets on Linux', () => {
    expect(planSigning({ ...certum, APPLE_CERTIFICATE: 'x' }, { platform: 'linux' })).toMatchObject({
      windows: 'none',
      macos: 'none',
      errors: [],
    });
  });
});

describe('prepatchBundleType', () => {
  it('writes the NSIS bundle type the Tauri bundler would patch in', () => {
    const exe = Buffer.from(`MZ....${BUNDLE_TYPE_PLACEHOLDER}....`, 'latin1');
    const out = prepatchBundleType(exe);
    expect(out.length).toBe(exe.length);
    expect(out.toString('latin1')).toContain(BUNDLE_TYPE_NSIS);
    expect(out.toString('latin1')).not.toContain(BUNDLE_TYPE_PLACEHOLDER);
    expect(prepatchBundleType(out)).toEqual(out);
    expect(() => prepatchBundleType(Buffer.from('MZ'))).toThrow(/not found/);
  });
});
