/**
 * SSRF-safe HTTPS GET for server-side fetches to instance domains
 * (the .well-known directory verification).
 *
 * 14th-audit: delegates to the SHARED IP-pinned transport — the
 * private copy's lookup callback returned a bare string, which Node
 * 22's autoSelectFamily (all:true) cannot consume; the connection
 * silently misbehaved. One transport for installer, review-pinning
 * and domain verification.
 */
import { fetchIpPinned, resolvePublicAddresses } from './ip-pinned-https';

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

const MAX_BODY_CHARS = 64 * 1024;

export async function ssrfSafeGet(
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<SafeFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS targets are allowed');
  }
  const addresses = await resolvePublicAddresses(parsed.hostname);
  const res = await fetchIpPinned(url, parsed.hostname, addresses, {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxStreamBytes: MAX_BODY_CHARS, // 64 KiB is plenty for the JSON doc
    userAgent: 'LobbyForge-Directory/1.0',
  });
  return {
    ok: res.ok,
    status: res.status,
    body: res.body.toString('utf8').slice(0, MAX_BODY_CHARS),
  };
}
