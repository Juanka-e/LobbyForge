import fs from 'fs';
import path from 'path';

const rootDir = 'd:/livekittest';

// List of package.json files found
const packageJsonFiles = [
  'apps/desktop/package.json',
  'apps/registry/package.json',
  'apps/web/package.json',
  'package.json',
  'packages/bot-sdk/package.json',
  'packages/config/package.json',
  'packages/core/package.json',
  'packages/db/package.json',
  'packages/i18n/package.json',
  'packages/plugin-sdk/package.json',
  'packages/ui/package.json',
  'plugins/hushle/package.json',
  'plugins/quiz/package.json',
  'plugins/vampire-village/package.json',
  'plugins/watch-party/package.json'
].map(f => path.join(rootDir, f));

for (const file of packageJsonFiles) {
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`\n--- ${path.relative(rootDir, file)} ---`);
    if (data.scripts) {
      for (const [name, cmd] of Object.entries(data.scripts)) {
        console.log(`  "${name}": "${cmd}"`);
      }
    } else {
      console.log('  No scripts');
    }
  } else {
    console.log(`File not found: ${file}`);
  }
}
