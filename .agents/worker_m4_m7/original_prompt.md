You are a Worker Agent.
Your mission is to complete the LobbyForge monorepo configuration by hardening all workspace package scripts for cross-platform execution, writing the root verification script, updating PROJECT.md milestone statuses, running verification commands, and ensuring a CLEAN audit status.

Please execute the following steps:

1. **Update PROJECT.md**:
   - Change Milestone 3 (Core & Shared Packages Scaffolding) status to `DONE`.
   - Change Milestone 4 (Plugins Scaffolding) and Milestone 5 (Apps Scaffolding) status to `DONE` (since they are already fully scaffolded).
   - Change Milestone 6 (Cross-Platform Scripts) status to `IN_PROGRESS`.

2. **Standardize Glob Quoting**:
   - Update the `lint` scripts in all package.json files to ensure all glob arguments are wrapped in escaped double-quotes (`\"`).
   - For all package.json files under `packages/*` and `plugins/*` and `apps/*`:
     - Standard `lint` scripts: `"lint": "eslint \"src/**/*.ts\""`
     - UI package (`packages/ui/package.json`): `"lint": "eslint \"src/**/*.{ts,tsx}\""`
     - Web app (`apps/web/package.json`): `"lint": "eslint \"src/**/*.{ts,tsx}\" \"app/**/*.{ts,tsx}\" \"lib/**/*.ts\""`

3. **Clean Up Escaped Quotes in Placeholder Scripts**:
   - Update the `dev` scripts in `apps/desktop/package.json` and `apps/registry/package.json` to avoid nested escaped quotes:
     - `apps/desktop/package.json`: `"dev": "echo desktop dev: Electron not yet wired in scaffold stage"`
     - `apps/registry/package.json`: `"dev": "echo registry dev: not yet wired in scaffold stage"`

4. **Implement Node.js-based Verification Script**:
   - Create `scripts/verify.js` at the root of the workspace. Use this cross-platform script to execute the sequential tasks:
     ```javascript
     import { spawnSync } from 'child_process';
     import os from 'os';

     const isWindows = os.platform() === 'win32';
     const spawnOptions = {
       stdio: 'inherit',
       shell: isWindows,
     };

     const tasks = [
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
     ```
   - Update the root `package.json` `"verify"` script to `"node scripts/verify.js"`.

5. **Run Verification**:
   - Execute the verification tasks:
     - `pnpm install`
     - `pnpm build`
     - `pnpm verify`
   - Make sure all commands succeed.

6. **Update PROJECT.md to Final State**:
   - Change Milestone 6 (Cross-Platform Scripts) and Milestone 7 (Documentation & Verification) status to `DONE` after everything passes.

7. **Documentation update**:
   - Verify `docs/CROSS_PLATFORM_NOTES.md` exists or update it to document the new `scripts/verify.js` and cross-platform scripting rules.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
