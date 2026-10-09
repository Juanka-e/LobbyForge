// Types for release-signing.mjs (imported by src/__tests__/installer.test.ts).

export const CERTUM_TIMESTAMP_URL: string;
export const SIGNATURE_NAME: string;
export const SIGNATURE_URL: string;
export const BUNDLE_TYPE_PLACEHOLDER: string;
export const BUNDLE_TYPE_NSIS: string;

export interface SigningPlan {
  platform: 'windows' | 'macos' | 'linux';
  windows: 'none' | 'certum' | 'signpath';
  macos: 'none' | 'sign' | 'notarize';
  bundles: string;
  tauriConfig: {
    bundle: { windows: { signCommand: { cmd: string; args: string[] } } };
  } | null;
  expectSignature: 'none' | 'present' | 'trusted';
  signpathPolicy: string;
  notes: string[];
  errors: string[];
}

export function planSigning(
  env: Record<string, string | undefined>,
  options: { platform: string; version?: string; releaseRef?: boolean; ssignPath?: string },
): SigningPlan;

export function prepatchBundleType(buffer: Buffer): Buffer;

export function describePlan(plan: SigningPlan): string[];
