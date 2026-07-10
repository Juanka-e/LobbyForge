import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('global web security policy', () => {
  const config = readFileSync(join(__dirname, '..', '..', 'next.config.mjs'), 'utf8');

  it('defines CSP anti-XSS and anti-framing boundaries', () => {
    expect(config).toContain("default-src 'self'");
    expect(config).toContain("object-src 'none'");
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain("base-uri 'self'");
    expect(config).toContain("form-action 'self'");
  });

  it('keeps unsafe-eval development-only and enables production HSTS', () => {
    expect(config).toContain("isProduction ? '' : \" 'unsafe-eval'\"");
    expect(config).toContain('Strict-Transport-Security');
    expect(config).toContain('max-age=63072000; includeSubDomains; preload');
  });
});
