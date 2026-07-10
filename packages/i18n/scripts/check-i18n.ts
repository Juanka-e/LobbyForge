import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '../locales');

function checkLocales() {
  const files = fs.readdirSync(localesDir).filter(file => file.endsWith('.json'));
  const masterFile = 'en.json';
  
  if (!files.includes(masterFile)) {
    console.error(`Master file ${masterFile} not found!`);
    process.exit(1);
  }

  const masterPath = path.join(localesDir, masterFile);
  const masterKeys = Object.keys(JSON.parse(fs.readFileSync(masterPath, 'utf8')));
  let hasError = false;

  for (const file of files) {
    if (file === masterFile) continue;
    
    const filePath = path.join(localesDir, file);
    let content;
    try {
      content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e: any) {
      console.error(`❌ Invalid JSON structure in ${file}:`, e.message);
      hasError = true;
      continue;
    }

    const currentKeys = Object.keys(content);
    
    // Check for missing keys
    const missingKeys = masterKeys.filter(key => !currentKeys.includes(key));
    if (missingKeys.length > 0) {
      console.error(`❌ ${file} is missing keys from ${masterFile}:`, missingKeys);
      hasError = true;
    }

    // Check for extraneous keys
    const extraKeys = currentKeys.filter(key => !masterKeys.includes(key));
    if (extraKeys.length > 0) {
      console.warn(`⚠️ ${file} has extraneous keys not present in ${masterFile}:`, extraKeys);
    }
  }

  if (hasError) {
    console.error('i18n validation check failed.');
    process.exit(1);
  } else {
    console.log('✅ All locale translation keys validated successfully.');
    process.exit(0);
  }
}

checkLocales();
