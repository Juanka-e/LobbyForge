import { describe, expect, it } from 'vitest';
import { MaintenanceSchema } from '../maintenance/route.js';
import { UpdateRequestSchema } from '../updates/route.js';

describe('admin request validation', () => {
  it('accepts bounded maintenance settings and rejects unknown fields', () => {
    expect(MaintenanceSchema.safeParse({ enabled: true, message: 'Scheduled work' }).success).toBe(true);
    expect(MaintenanceSchema.safeParse({ enabled: true, unexpected: true }).success).toBe(false);
    expect(MaintenanceSchema.safeParse({ enabled: true, message: 'x'.repeat(501) }).success).toBe(false);
  });

  it('defaults an empty update request to dry-run', () => {
    const parsed = UpdateRequestSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.action).toBe('dry-run');
  });

  it('rejects ignored fields and unbounded worker output', () => {
    expect(UpdateRequestSchema.safeParse({ action: 'verify-backup', execute: true }).success).toBe(false);
    expect(UpdateRequestSchema.safeParse({ action: 'apply', maxOutputBytes: 1024 * 1024 + 1 }).success).toBe(false);
    expect(UpdateRequestSchema.safeParse({ action: 'unknown' }).success).toBe(false);
  });
});
