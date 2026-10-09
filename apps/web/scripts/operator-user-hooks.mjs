/**
 * Module resolution hooks for scripts/operator-user.mjs.
 *
 * The app's TypeScript sources are written for Next.js's bundler, which
 * resolves more than Node does:
 *   - `@/lib/x`: the tsconfig `paths` alias for the app root;
 *   - `./x`: a local import without an extension (`.ts`, `/index.ts`);
 *   - `next/server`: a package subpath without an `exports` map, which
 *     Node only finds with its extension (`next/server.js`).
 * These hooks add exactly that, for imports made BY the app's own files;
 * everything else resolves as usual. Node's type stripping then loads the
 * `.ts` files.
 */
const WEB_ROOT = new URL('../', import.meta.url);
const LOCAL_SUFFIXES = ['.ts', '/index.ts'];
const PACKAGE_SUFFIXES = ['.js'];
const RETRYABLE = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

function isAppSource(url) {
  return typeof url === 'string' && url.startsWith(WEB_ROOT.href) && !url.includes('/node_modules/');
}

/** `next/server` yes; `next`, `@scope/pkg`, `node:fs` no. */
function isPackageSubpath(specifier) {
  if (specifier.includes(':')) return false;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.length > 2 : parts.length > 1;
}

async function resolveWithSuffixes(target, suffixes, context, nextResolve) {
  try {
    return await nextResolve(target, context);
  } catch (error) {
    if (!RETRYABLE.has(error?.code)) throw error;
    for (const suffix of suffixes) {
      try {
        return await nextResolve(`${target}${suffix}`, context);
      } catch {
        // try the next suffix
      }
    }
    throw error;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return resolveWithSuffixes(new URL(specifier.slice(2), WEB_ROOT).href, LOCAL_SUFFIXES, context, nextResolve);
  }
  if (!isAppSource(context.parentURL)) return nextResolve(specifier, context);
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveWithSuffixes(specifier, LOCAL_SUFFIXES, context, nextResolve);
  }
  if (isPackageSubpath(specifier)) {
    return resolveWithSuffixes(specifier, PACKAGE_SUFFIXES, context, nextResolve);
  }
  return nextResolve(specifier, context);
}
