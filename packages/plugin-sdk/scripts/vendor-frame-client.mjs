#!/usr/bin/env node
/**
 * Copies the frame client (src/frame/client.ts, compiled to plain ESM) into a
 * plugin's `ui/` folder, so a marketplace plugin can ship it as a file — the
 * sandboxed frame has no network and no CDN.
 *
 *   node packages/plugin-sdk/scripts/vendor-frame-client.mjs            # write
 *   node packages/plugin-sdk/scripts/vendor-frame-client.mjs --check    # exit 1 if stale
 *   node packages/plugin-sdk/scripts/vendor-frame-client.mjs <out.js>   # another plugin
 *
 * client.ts has only type imports, so the output has no imports at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..');
const source = resolve(sdkRoot, 'src/frame/client.ts');
const defaultOut = resolve(sdkRoot, '../../examples/plugins/sandbox-buzzer/ui/lobbyforge-frame.js');

const HEADER =
  '// @lobbyforge/plugin-sdk/frame — the frame client, as plain ESM with no imports.\n' +
  '// Generated from packages/plugin-sdk/src/frame/client.ts by\n' +
  '// packages/plugin-sdk/scripts/vendor-frame-client.mjs. Do not edit: re-run it.\n';

export function renderFrameClient() {
  const { outputText } = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      verbatimModuleSyntax: false,
    },
    fileName: 'client.ts',
  });
  return HEADER + outputText;
}

const normalise = (text) => text.replace(/\r\n/g, '\n');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const out = resolve(args.find((a) => !a.startsWith('--')) ?? defaultOut);
  const expected = renderFrameClient();
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(out, 'utf8');
    } catch {
      actual = '';
    }
    if (normalise(actual) !== normalise(expected)) {
      console.error(`${out} is out of date. Run: node packages/plugin-sdk/scripts/vendor-frame-client.mjs`);
      process.exit(1);
    }
    console.log(`${out} is up to date.`);
  } else {
    writeFileSync(out, expected);
    console.log(`wrote ${out}`);
  }
}
