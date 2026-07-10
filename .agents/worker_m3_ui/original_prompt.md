## 2026-06-10T00:44:21Z
You are a teamwork_preview_worker. Please scaffold `@lobbyforge/ui` in packages/ui.
First, make sure the directory packages/ui exists.
Then, create the following files under packages/ui/ matching the specification in the exploration report:
1. `package.json` (make sure it includes peerDependencies for react and react-dom, and devDependencies for `@testing-library/react` and `happy-dom` as specified in the plan)
2. `tsconfig.json` (inherits from `@lobbyforge/config/tsconfig.base.json`, and contains `"jsx": "react-jsx"` inside its compilerOptions)
3. `vitest.config.ts` (configured with `happy-dom` test environment)
4. `src/Button.tsx` (React component, variant styling classes, click handler)
5. `src/Modal.tsx` (React modal component, onClose overlay trigger)
6. `src/Card.tsx` (React card component, title, footer, body custom styles)
7. `src/Tooltip.tsx` (React tooltip component, hover toggle)
8. `src/Avatar.tsx` (React avatar component, sizes, statuses, and initials fallback)
9. `src/Spinner.tsx` (React loading spinner component)
10. `src/index.ts` (main export hub)
11. `src/__tests__/Button.test.tsx` (component tests using React Testing Library and happy-dom)

Make sure the files inherit from @lobbyforge/config/tsconfig.base.json.
After implementing, run "pnpm install" from the root directory to link the workspace, and run build/typecheck/test for the package to verify it builds and passes tests successfully.
Do not write or use any dummy or facade implementations.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your working directory is d:\livekittest\.agents\worker_m3_ui. Save your handoff to d:\livekittest\.agents\worker_m3_ui\handoff.md. Report back when complete.
