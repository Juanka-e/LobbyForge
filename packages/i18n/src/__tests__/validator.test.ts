import { describe, it, expect } from 'vitest';
import { validateLocale } from '../validator.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const en = require('../../locales/en.json');
const tr = require('../../locales/tr.json');

describe('i18n Locale Validation', () => {
  it('should validate valid locale files against en.json', () => {
    const resultTr = validateLocale(en, tr);
    expect(resultTr.isValid).toBe(true);
  });

  it('should identify missing keys', () => {
    const base = { greeting: 'Hello', fare: 'Goodbye' };
    const target = { greeting: 'Merhaba' };
    const result = validateLocale(base, target);
    expect(result.isValid).toBe(false);
    expect(result.missingKeys).toContain('fare');
    expect(result.extraKeys.length).toBe(0);
  });

  it('should identify extra keys', () => {
    const base = { greeting: 'Hello' };
    const target = { greeting: 'Merhaba', extra: 'Extra' };
    const result = validateLocale(base, target);
    expect(result.isValid).toBe(false);
    expect(result.extraKeys).toContain('extra');
    expect(result.missingKeys.length).toBe(0);
  });

  it('should identify placeholder mismatches', () => {
    const base = { welcome: 'Hello {name}!' };
    const target = { welcome: 'Hello {username}!' };
    const result = validateLocale(base, target);
    expect(result.isValid).toBe(false);
    expect(result.placeholderMismatches.length).toBeGreaterThan(0);
  });

  it('should pass validation when keys and placeholders match exactly', () => {
    const base = { welcome: 'Hello {name}!', bye: 'Bye' };
    const target = { welcome: 'Merhaba {name}!', bye: 'Güle güle' };
    const result = validateLocale(base, target);
    expect(result.isValid).toBe(true);
  });
});
