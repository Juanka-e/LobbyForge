import { z } from 'zod';

export const DisplayNameSchema = z.string()
  .min(2, 'Display name must be at least 2 characters')
  .max(64, 'Display name must be at most 64 characters')
  .transform(s => s.trim())
  .refine(s => !/[\u0000-\u001F\u007F-\u009F]/.test(s), 'Display name must not contain control characters');

export const EmailSchema = z.string()
  .transform(s => s.trim().toLowerCase())
  .pipe(z.string().email('Invalid email address').max(320, 'Email must be at most 320 characters'));

export const PasswordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const ServerNameSchema = z.string()
  .min(2, 'Server name must be at least 2 characters')
  .max(100, 'Server name must be at most 100 characters')
  .transform(s => s.trim());

export const ChannelNameSchema = z.string()
  .min(1, 'Channel name must be at least 1 character')
  .max(100, 'Channel name must be at most 100 characters')
  .transform(s => s.trim())
  .refine(s => !s.startsWith('#'), 'Channel name must not start with #');

export const MessageContentSchema = z.string()
  .min(1, 'Message content cannot be empty')
  .max(4000, 'Message content must be at most 4000 characters');

export const InviteCodeSchema = z.string()
  .min(6, 'Invite code must be at least 6 characters')
  .max(16, 'Invite code must be at most 16 characters')
  .regex(/^[a-zA-Z0-9]+$/, 'Invite code must be alphanumeric');

export const SlugSchema = z.string()
  .min(2, 'Slug must be at least 2 characters')
  .max(50, 'Slug must be at most 50 characters')
  .regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens');

// Grouped Forms
export const RegisterInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});

export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

export const CreateServerInputSchema = z.object({
  name: ServerNameSchema,
  slug: SlugSchema.optional(),
});
