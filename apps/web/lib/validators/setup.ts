import { z } from 'zod';

const SAFE_VISIBLE_TEXT = /^[^<>\u0000-\u001F\u007F-\u009F]*$/;

/**
 * /setup wizard — input schema. The wizard collects four pieces of
 * state across its steps; the final POST sends all of them in one
 * payload so the API can validate atomically and avoid partial writes.
 *
 * Length limits match the DB column sizes:
 *   - instance_name:    text, capped to 80 chars at the DB layer
 *   - display_name:     text, capped to 64 chars at the DB layer
 *   - seo_title:        varchar(70)
 *   - seo_description:  varchar(160)
 */
export const completeSetupSchema = z.object({
  setupToken: z.string().max(256).optional(),
  instanceName: z
    .string()
    .trim()
    .min(2, 'Instance name must be at least 2 characters.')
    .max(80, 'Instance name must be at most 80 characters.')
    .regex(SAFE_VISIBLE_TEXT, 'Instance name contains unsupported characters.'),
  ownerDisplayName: z
    .string()
    .trim()
    .min(2, 'Display name must be at least 2 characters.')
    .max(64, 'Display name must be at most 64 characters.')
    .regex(SAFE_VISIBLE_TEXT, 'Display name contains unsupported characters.'),
  ownerEmail: z.string().trim().toLowerCase().email('Enter a valid owner email address.').max(254),
  ownerPassword: z
    .string()
    .min(12, 'Owner password must be at least 12 characters.')
    .max(128, 'Owner password must be at most 128 characters.'),
  registrationMode: z.enum(['open', 'invite_only', 'closed']),
  guestAccessEnabled: z.boolean(),
  seoIndexingEnabled: z.boolean(),
  seoTitle: z.string().trim().max(70).regex(SAFE_VISIBLE_TEXT).optional().nullable(),
  seoDescription: z.string().trim().max(160).regex(SAFE_VISIBLE_TEXT).optional().nullable(),
});

export type CompleteSetupInput = z.infer<typeof completeSetupSchema>;
