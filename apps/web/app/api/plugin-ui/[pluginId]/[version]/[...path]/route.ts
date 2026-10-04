/**
 * GET/HEAD /api/plugin-ui/{pluginId}/{version}/{...path}
 *
 * A marketplace plugin's UI files, for the lobby's
 * `<iframe sandbox="allow-scripts">` (ADR-007). Public, cookie-free and
 * immutable; the headers are the security boundary — see
 * lib/plugin-ui-assets.ts for each one and why.
 *
 * Not wrapped in `withApiSecurity`: that wrapper stamps
 * `X-Frame-Options: DENY` on every response (the frame could never load) and
 * runs session-revocation and maintenance checks that need Postgres/Redis for
 * a static, unauthenticated file. Next answers 405 for any other method.
 */
import { servePluginUiAsset } from '@/lib/plugin-ui-assets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ pluginId: string; version: string; path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return servePluginUiAsset(req, await ctx.params);
}

export async function HEAD(req: Request, ctx: Ctx): Promise<Response> {
  return servePluginUiAsset(req, await ctx.params);
}
