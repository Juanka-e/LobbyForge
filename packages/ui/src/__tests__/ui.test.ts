import { describe, it, expect } from 'vitest';
import { defaultButtonVariant, isButtonVariant } from '../index.js';

describe('@lobbyforge/ui', () => {
  it('defaultButtonVariant is primary', () => {
    expect(defaultButtonVariant).toBe('primary');
  });

  it('isButtonVariant narrows correctly', () => {
    expect(isButtonVariant('primary')).toBe(true);
    expect(isButtonVariant('danger')).toBe(true);
    expect(isButtonVariant('not-a-variant')).toBe(false);
    expect(isButtonVariant(undefined)).toBe(false);
  });
});
