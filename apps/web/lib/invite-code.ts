export const INVITE_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

export function normalizeInviteCode(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return INVITE_CODE_PATTERN.test(normalized) ? normalized : null;
}
