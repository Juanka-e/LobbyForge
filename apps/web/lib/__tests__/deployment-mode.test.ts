import { describe, expect, it } from 'vitest';
import { getDeploymentMode } from '../deployment-mode.js';

describe('getDeploymentMode', () => {
  it('enables official behavior only when explicitly configured', () => {
    expect(getDeploymentMode('official')).toBe('official');
  });

  it('defaults invalid and missing values to self-host', () => {
    expect(getDeploymentMode(undefined)).toBe('self_host');
    expect(getDeploymentMode('OFFICIAL')).toBe('self_host');
    expect(getDeploymentMode('unexpected')).toBe('self_host');
  });
});
