import { spawnSync } from 'child_process';
import os from 'os';

const isWindows = os.platform() === 'win32';
const spawnOptions = {
  stdio: 'inherit',
  shell: isWindows,
};

const tasks = [
  // Build packages FIRST — workspace typecheck imports their dist/ type
  // declarations (e.g. plugins/quiz needs @lobbyforge/plugin-sdk built).
  { name: 'Build packages', cmd: 'pnpm', args: ['build:packages'] },
  { name: 'Typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'Lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'Test', cmd: 'pnpm', args: ['test'] }
];

console.log('🚀 Starting LobbyForge Monorepo Verification...');

for (const task of tasks) {
  console.log(`\n========================================`);
  console.log(`🏃 Running Task: ${task.name} (${task.cmd} ${task.args.join(' ')})`);
  console.log(`========================================`);
  
  const result = spawnSync(task.cmd, task.args, spawnOptions);
  
  if (result.error) {
    console.error(`❌ Process Error in ${task.name}:`, result.error.message);
    process.exit(1);
  }
  
  if (result.status !== 0) {
    console.error(`\n❌ Task failed: ${task.name} with exit status ${result.status}`);
    process.exit(result.status || 1);
  }
}

console.log('\n========================================');
console.log('✅ All verification tasks passed successfully!');
console.log('========================================');
process.exit(0);
