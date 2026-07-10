import { describe, it, expect } from 'vitest';
import { DisplayNameSchema, EmailSchema, ChannelNameSchema, SlugSchema } from '../validation.js';

describe('Validation Schemas', () => {
  describe('DisplayNameSchema', () => {
    it('should pass and trim valid display names', () => {
      expect(DisplayNameSchema.parse('  Alice  ')).toBe('Alice');
    });

    it('should reject too short or too long names', () => {
      expect(() => DisplayNameSchema.parse('A')).toThrow();
      expect(() => DisplayNameSchema.parse('A'.repeat(65))).toThrow();
    });

    it('should reject control characters', () => {
      expect(() => DisplayNameSchema.parse('Alice\nBob')).toThrow();
    });
  });

  describe('EmailSchema', () => {
    it('should parse and lowercase valid email addresses', () => {
      expect(EmailSchema.parse('  TEST@Example.com  ')).toBe('test@example.com');
    });

    it('should reject invalid email formatting', () => {
      expect(() => EmailSchema.parse('invalid-email')).toThrow();
    });
  });

  describe('ChannelNameSchema', () => {
    it('should reject channel names starting with #', () => {
      expect(() => ChannelNameSchema.parse('#general')).toThrow();
      expect(ChannelNameSchema.parse('general')).toBe('general');
    });
  });

  describe('SlugSchema', () => {
    it('should only accept lowercase letters, numbers, and hyphens', () => {
      expect(SlugSchema.parse('my-cool-server-123')).toBe('my-cool-server-123');
      expect(() => SlugSchema.parse('My-Server')).toThrow();
      expect(() => SlugSchema.parse('my_server')).toThrow();
    });
  });
});
