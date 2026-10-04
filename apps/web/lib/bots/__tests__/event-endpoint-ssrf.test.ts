import { describe, expect, it, vi } from 'vitest';

/**
 * BOT_API_V2 §5.2 / §8: an outgoing endpoint can never point at a private
 * network. The REAL resolver runs (`ip-pinned-https.ts` + `ip-ranges.ts`);
 * every case below is an IP literal or a local name, so nothing leaves the
 * machine. Only the database is stubbed (the module imports it).
 */
vi.mock('@lobbyforge/db', () => ({}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

const REFUSED = [
  'https://127.0.0.1/hook', // loopback
  'https://127.1.2.3:8443/hook',
  'https://10.0.0.5/hook', // private
  'https://172.16.4.4/hook',
  'https://192.168.1.10/hook',
  'https://169.254.169.254/latest/meta-data', // cloud metadata (link-local)
  'https://100.64.0.1/hook', // CGNAT
  'https://0.0.0.0/hook',
  'https://[::1]/hook', // IPv6 loopback
  'https://[fd00::1]/hook', // ULA
  'https://[fe80::1]/hook', // link-local
  'https://[::ffff:127.0.0.1]/hook', // IPv4-mapped loopback
  'https://localhost/hook',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://printer.local/hook',
  'http://93.184.216.34/hook', // public, but not https
];

describe('event endpoint URL — save-time SSRF check', () => {
  it.each(REFUSED)('refuses %s', async (url) => {
    const { validateEndpointUrl } = await import('../event-delivery');
    const verdict = await validateEndpointUrl(url);
    expect(verdict.ok).toBe(false);
  });

  it('accepts a public address over https', async () => {
    const { validateEndpointUrl } = await import('../event-delivery');
    expect(await validateEndpointUrl('https://93.184.216.34/hook')).toMatchObject({ ok: true, hostname: '93.184.216.34' });
  });
});
