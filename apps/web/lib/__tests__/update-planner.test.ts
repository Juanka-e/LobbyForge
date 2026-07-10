import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildUpdateCheck,
  buildUpdatePlan,
  canonicalizeReleaseManifest,
  compareVersions,
  validateManifest,
  verifyReleaseManifestSignature,
  type ReleaseManifest,
} from '@/lib/update-planner';

const manifest: ReleaseManifest = {
  channel: 'stable',
  version: '1.2.3',
  minimumVersion: '1.0.0',
  releaseNotes: 'Ship it carefully.',
  breakingChanges: ['Read the notes.'],
  commands: {
    doctor: 'lfctl doctor',
    backup: 'lfctl backup create',
  },
};

describe('update planner', () => {
  it('compares semantic versions', () => {
    expect(compareVersions('1.2.3', '1.2.2')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  });

  it('builds update check metadata', () => {
    const check = buildUpdateCheck(manifest, '1.1.0');
    expect(check.updateAvailable).toBe(true);
    expect(check.majorUpgrade).toBe(false);
    expect(check.currentSupported).toBe(true);
    expect(check.breakingChanges).toEqual(['Read the notes.']);
  });

  it('marks major upgrades for extra confirmation', () => {
    const plan = buildUpdatePlan({ ...manifest, version: '2.0.0' }, '1.9.9');
    expect(plan.majorUpgrade).toBe(true);
    expect(plan.requiresExtraMajorConfirmation).toBe(true);
  });

  it('always includes backup before compose recreate', () => {
    const plan = buildUpdatePlan(manifest, '1.1.0');
    const backupIndex = plan.steps.findIndex((step) => step.id === 'backup');
    const recreateIndex = plan.steps.findIndex((step) => step.id === 'recreate-services');
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(recreateIndex).toBeGreaterThan(backupIndex);
    expect(plan.safeToAutoApply).toBe(false);
  });

  it('rejects invalid manifests', () => {
    expect(() => validateManifest({ channel: 'stable' })).toThrow(/version/);
    expect(() => validateManifest({ version: '1.0.0', commands: { doctor: 123 } })).toThrow(/commands/);
    expect(() => validateManifest({ version: '1.0.0', unexpected: true })).toThrow(/Unknown/);
  });

  it('reports missing signature when a public key is configured', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const result = verifyReleaseManifestSignature(
      manifest,
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    );
    expect(result.status).toBe('missing');
  });

  it('verifies a signed manifest', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const unsignedManifest = { ...manifest, keyId: 'test-key' };
    const signature = sign(null, Buffer.from(canonicalizeReleaseManifest(unsignedManifest), 'utf8'), privateKey)
      .toString('base64url');
    const signedManifest = { ...unsignedManifest, signature };
    const result = verifyReleaseManifestSignature(
      signedManifest,
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    );
    expect(result).toEqual({ status: 'valid', verified: true, required: true, keyId: 'test-key' });
  });
});
