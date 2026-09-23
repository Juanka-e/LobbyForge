#!/usr/bin/env node
// LobbyForge translations — see docs/TRANSLATING.md.
//
//   pnpm i18n:add <code> --name <native> --english <English> [--rtl]
//   pnpm i18n:status
//   pnpm i18n:sync [--prune]
//   pnpm i18n:complete <code>

import { addLanguage, markComplete, status, sync } from './i18n/lib.mjs';

const [command, ...rest] = process.argv.slice(2);

function option(name) {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}
const flag = (name) => rest.includes(`--${name}`);
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));

const pct = (done, total) => (total === 0 ? 100 : Math.floor((done / total) * 100));
const bar = (done, total) => {
  const filled = Math.round((pct(done, total) / 100) * 20);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
};

function printStatus() {
  const report = status();
  console.log('\nApp — apps/web/messages\n');
  for (const row of report.appRows) {
    const label = row.name === row.englishName ? row.name : `${row.name} (${row.englishName})`;
    const flags = [row.status, row.dir === 'rtl' ? 'rtl' : null].filter(Boolean).join(', ');
    console.log(
      `  ${row.code.padEnd(8)} ${label.padEnd(26)} ${bar(row.translated, row.total)} ${String(
        pct(row.translated, row.total)
      ).padStart(3)}%  ${row.translated}/${row.total}  ${flags}`
    );
  }
  console.log('\nPlugins — plugins/*/locales\n');
  for (const plugin of report.pluginRows) {
    const langs = plugin.languages
      .map((l) => `${l.code} ${pct(l.translated, l.total)}%${l.partial ? ' (partial)' : ''}`)
      .join('  ·  ');
    console.log(`  ${plugin.id.padEnd(16)} ${langs}`);
  }
  if (report.englishOnlyPlugins.length > 0) {
    console.log(`\n  English only (no locales/ folder): ${report.englishOnlyPlugins.join(', ')}`);
  }
  if (report.problems.length === 0) {
    console.log('\n✔ No problems.\n');
    return 0;
  }
  console.log(`\n✖ ${report.problems.length} problem(s):\n`);
  for (const problem of report.problems) console.log(`  - ${problem}`);
  console.log('');
  return 1;
}

try {
  switch (command) {
    case 'add': {
      const [code] = positional;
      const created = addLanguage({
        code,
        name: option('name'),
        englishName: option('english'),
        rtl: flag('rtl'),
      });
      console.log(`\nAdded ${code}. Created ${created.length} files, every string blank and ready to translate:\n`);
      for (const file of created) console.log(`  ${file}`);
      console.log(`
Next:
  1. Fill in the blank strings. English is beside each file in the en/ folder,
     in the same order. Blanks show English until translated, so you can
     ship a partial translation at any point.
  2. \`pnpm i18n:status\` shows how far along you are.
  3. When everything is translated, \`pnpm i18n:complete ${code}\`.
`);
      process.exit(0);
      break;
    }
    case 'sync': {
      const changed = sync({ prune: flag('prune') });
      console.log(changed.length ? `Updated:\n  ${changed.join('\n  ')}` : 'Everything already in sync.');
      process.exit(printStatus());
      break;
    }
    case 'complete': {
      const [code] = positional;
      markComplete({ code });
      console.log(`${code} is now marked complete — the tests will hold it to that.`);
      process.exit(0);
      break;
    }
    case 'status':
    case undefined:
      process.exit(printStatus());
      break;
    default:
      console.error(`Unknown command "${command}". Try: add, status, sync, complete.`);
      process.exit(2);
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
