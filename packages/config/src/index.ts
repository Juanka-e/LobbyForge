import { z } from 'zod';

export const AppConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  host: z.string().default('localhost'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  livekit: z.object({
    url: z.string().url(),
    apiKey: z.string(),
    apiSecret: z.string(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(envSource: Record<string, string | undefined> = process.env): AppConfig {
  return AppConfigSchema.parse({
    env: envSource.NODE_ENV,
    port: envSource.PORT,
    host: envSource.HOST,
    databaseUrl: envSource.DATABASE_URL,
    redisUrl: envSource.REDIS_URL,
    livekit: {
      url: envSource.LIVEKIT_URL,
      apiKey: envSource.LIVEKIT_API_KEY,
      apiSecret: envSource.LIVEKIT_API_SECRET,
    },
  });
}
