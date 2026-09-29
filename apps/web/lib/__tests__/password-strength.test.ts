import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../password-strength';

describe('passwordStrength', () => {
  it('says nothing about an empty field', () => {
    expect(passwordStrength('')).toEqual({ level: 'empty', score: 0 });
  });

  it('blocks anything under the server minimum of 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordStrength('Sh0rt!pass')).toEqual({ level: 'tooShort', score: 1 });
    expect(passwordStrength('a'.repeat(11))).toEqual({ level: 'tooShort', score: 1 });
  });

  it('rates a long password of one kind of character only as fair', () => {
    expect(passwordStrength('longpassword').level).toBe('fair');
  });

  it('rates a handful of characters repeated as fair, however long', () => {
    expect(passwordStrength('abababababababababababab').level).toBe('fair');
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').level).toBe('fair');
  });

  it('rates the design example — a 21-character passphrase — as strong', () => {
    expect(passwordStrength('correct-horse-battery')).toEqual({ level: 'strong', score: 3 });
  });

  it('rates length plus variety as very strong', () => {
    expect(passwordStrength('Correct-Horse-Battery-9').level).toBe('veryStrong');
    expect(passwordStrength('correct-horse-battery-staple').level).toBe('veryStrong');
  });

  it('counts length the way the server does', () => {
    // 12 UTF-16 units: accepted by the API's min(12), so not "too short".
    expect(passwordStrength('ağaç-ağaç-12').level).not.toBe('tooShort');
  });
});
