# Updates

LobbyForge self-host updates are planned as a guarded pipeline, not a direct
`docker compose pull && up` button.

## CLI

The first CLI surface is `scripts/lfctl.mjs`:

```bash
pnpm lfctl update check --manifest infra/update/release-manifest.example.json
pnpm lfctl update plan --manifest infra/update/release-manifest.example.json
pnpm lfctl update plan --manifest infra/update/release-manifest.example.json --json
pnpm lfctl backup verify --manifest infra/update/backup-manifest.example.json
```

`update apply` and `update rollback` are intentionally locked for now. They
return a non-zero exit code until the self-host script runner can execute the
allowlisted plan after verifying:

- admin confirmation
- doctor preflight
- successful backup
- migration dry-run
- compose pull/recreate
- post-update health check
- rollback command availability

## Manifest

The release manifest describes the latest version and the commands a self-host
instance should plan:

```json
{
  "channel": "stable",
  "version": "0.1.1",
  "keyId": "local-dev-example",
  "minimumVersion": "0.1.0",
  "releaseNotes": "Example stable update manifest for self-host planning.",
  "breakingChanges": [],
  "commands": {
    "doctor": "lfctl doctor",
    "backup": "lfctl backup create",
    "composePull": "docker compose pull",
    "composeUp": "docker compose up -d --remove-orphans",
    "healthCheck": "curl -fsS http://localhost:3000/api/health",
    "rollback": "docker compose up -d --remove-orphans"
  },
  "migrations": {
    "dryRunCommand": "pnpm --filter @lobbyforge/db db:generate -- --dry-run",
    "applyCommand": "pnpm --filter @lobbyforge/db db:migrate"
  }
}
```

The manifest can be a local file or an HTTP(S) URL.

## Signature Verification

Release manifests support a detached Ed25519 signature:

- `signature` is base64url-encoded.
- The signed payload is the canonical JSON manifest with the `signature` field
  omitted and object keys sorted.
- `keyId` is informational and helps rotate release keys.
- Web/API verification reads `LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM`.
- CLI verification reads `LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM` or
  `--public-key <pem-file>`.

Signature status appears in both API and CLI output:

- `not_configured`: no public key is configured. Local/dev planning can still
  work, but execution stays locked.
- `missing`: public key configured, manifest has no signature.
- `invalid`: signature failed verification.
- `valid`: manifest verified with the configured public key.

Production apply must require `valid` before any script runner executes.

## Runner Gate

The web API now builds an execution preview for `dry-run`, `apply`, and
`rollback`. It does not execute OS commands yet. The preview validates:

- `LOBBYFORGE_UPDATE_EXECUTION_ENABLED=true`
- release manifest signature is verified
- backup verification passed
- admin explicitly confirmed the operation
- major upgrades received the second confirmation
- maintenance mode is enabled before apply or rollback
- every planned command is in the runner allowlist

Current allowlisted commands are intentionally narrow:

```txt
lfctl doctor
lfctl backup create
docker compose pull
pnpm --filter @lobbyforge/db db:generate -- --dry-run
pnpm --filter @lobbyforge/db db:migrate
docker compose up -d --remove-orphans
curl -fsS http://localhost:3000/api/health
```

Custom manifest commands outside this set are rejected by the preview. This is
the safety boundary that prevents a registry or manifest problem from becoming
arbitrary shell execution.

## Backup Verification

Update apply is gated by a backup manifest. The initial verifier checks:

- backup completed successfully
- `createdAt` is valid, not in the future, and fresh enough
- database dump is included
- database dump has a SHA-256 digest
- database dump size is non-zero
- optional artifact existence when `--require-files` or API
  `requireFileExists: true` is used

Example:

```json
{
  "formatVersion": 1,
  "backupId": "local-dev-example",
  "createdAt": "2026-06-11T00:00:00.000Z",
  "appVersion": "0.1.0",
  "completed": true,
  "databaseDump": {
    "path": "backups/local-dev-example/postgres.dump",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": 1024
  },
  "includes": {
    "database": true,
    "uploads": false,
    "env": false,
    "pluginSettings": true,
    "registryConfig": true
  },
  "files": []
}
```

`POST /api/admin/updates` with `{ "action": "verify-backup" }` returns
`{ backup }`. `POST /api/admin/updates` with `{ "action": "dry-run" }`
returns `{ plan, backup, run, worker }`. `run` is the gate preview; `worker`
is the step-level execution contract. Apply/rollback remain non-executing
unless every gate and the explicit execution request are present.

The worker defaults to non-executing:

- dry-run steps are reported as `planned`
- apply/rollback steps are blocked until the execution gates pass
- the `commandExecutor` gate is false unless worker execution is enabled
- no OS command is spawned for previews or partially satisfied requests

## Command Executor Contract

The runner now prepares allowlisted commands as structured descriptors before
any execution layer can exist:

```json
{
  "stepId": "pull-images",
  "command": "docker compose pull",
  "executable": "docker",
  "args": ["compose", "pull"],
  "cwd": "workspace",
  "shell": false,
  "timeoutMs": 300000
}
```

This contract is the boundary between the signed update plan and the future
process runner:

- commands must exactly match the step allowlist
- command strings are normalized only for whitespace
- shell execution is not allowed
- executable and argv are hardcoded by step id
- timeouts are assigned per command class
- apply/rollback execute only through the explicitly enabled process runner

`executePreparedUpdateCommand` is the guarded process runner. It only runs
when called with explicit `execute` mode, and the web API selects that mode
only after its independent policy checks pass.

Runner safety properties:

- uses `spawn` with `shell: false`
- runs from the workspace directory
- hides child windows on Windows
- enforces per-command timeout
- captures bounded stdout/stderr
- reports stdout/stderr chunks through the event callback
- marks non-zero exits, startup errors, and timeouts distinctly

`executeUpdateWorker` orchestrates prepared worker steps:

- locked workers return `blocked` without running anything
- dry-run/disabled modes return the planned steps without running anything
- execute mode runs prepared descriptors sequentially
- the first blocked, failed, or timed-out step stops the worker
- command events are forwarded to the caller so the API layer can persist them
  in `system_update_events`

`buildUpdateExecutionPolicy` is the final mode selector before any live worker
execution can happen:

- `dry-run` returns `mode: "dry-run"`
- apply/rollback require all preview gates to pass
- apply/rollback require the worker to be `planned`
- apply/rollback require the call site to explicitly request execution
- without an explicit execution request the policy returns `mode: "disabled"`

The command-executor preview gate is controlled separately from the older
`LOBBYFORGE_UPDATE_EXECUTION_ENABLED` gate:

- `LOBBYFORGE_UPDATE_EXECUTION_ENABLED=true` allows apply/rollback previews to
  pass the generic execution gate.
- `LOBBYFORGE_UPDATE_WORKER_EXECUTION_ENABLED=true` allows the worker executor
  gate to pass.
- The admin API still sends `requestedExecution: false`, so apply/rollback
  remains locked unless the POST body explicitly includes `"execute": true`.

Apply/rollback endpoint wiring is now present but still gated. A live run
requires all of these at the same time:

- `action` is `apply` or `rollback`
- request body includes `"execute": true`
- `LOBBYFORGE_UPDATE_EXECUTION_ENABLED=true`
- `LOBBYFORGE_UPDATE_WORKER_EXECUTION_ENABLED=true`
- signed manifest is verified
- backup verification passes
- admin confirmation is true
- major-upgrade confirmation is true when needed
- maintenance mode is enabled
- every command is allowlisted

When execution is accepted, the API creates a `running` update run, streams
worker lifecycle and command events into `system_update_events`, then finishes
the run as `succeeded`, `failed`, or `rolled_back`.

`recordUpdatePreviewEvents` and `executeUpdateWorkerWithEvents` provide the
shared event-recorder adapter used by the admin API and future live execution:

- preview writes one run summary event and one event per worker step
- execution writes lifecycle events before and after worker execution
- command stdout/stderr/start/finish events are forwarded unchanged
- the adapter accepts an injected recorder, so tests can use memory and the API
  can use `system_update_events`

Every POST preview attempts to append a `system_update_runs` row. If the
history write fails, the API still returns the preview with `historyError` so
admins can see the gate result without mistaking history persistence for
execution safety.

## Update History

Self-host update history is modeled in `system_update_runs`. It records:

- action: `dry-run`, `apply`, or `rollback`
- status: `planned`, `locked`, `running`, `succeeded`, `failed`, or
  `rolled_back`
- from/to version, channel, manifest key id, backup id
- serialized plan, gates, and failures
- actor and start/finish timestamps

Step and worker events are modeled in `system_update_events`. It records:

- parent update run id
- optional step id
- level: `debug`, `info`, `warn`, or `error`
- message
- structured metadata
- event timestamp

`GET /api/admin/updates?action=history` returns the newest runs.
`GET /api/admin/updates?action=run&id=<runId>` returns one run plus its events
with the gate snapshot, failures, and rollback command snapshot. Normal
`check`/`plan` requests do not require the database.

Dry-run/apply/rollback previews write an initial event and one worker-step
event per planned/blocked step when the run row is recorded. Future process
execution should append bounded stdout/stderr chunks, step starts, step exits,
timeout events, and rollback decisions to the same event stream.

## Maintenance Mode

Maintenance mode is stored on `instance_settings`:

- `maintenance_mode`
- `maintenance_message`
- `maintenance_started_at`
- `maintenance_updated_at`

`GET /api/admin/maintenance` returns the current mode. `PATCH
/api/admin/maintenance` accepts:

```json
{
  "enabled": true,
  "message": "Updating LobbyForge. Voice and games may reconnect shortly."
}
```

Apply/rollback previews fail their maintenance gate until maintenance mode is
enabled.

Runtime guard behavior:

- normal API routes return `503` with `Retry-After: 60`
- normal pages render a maintenance screen
- admin, health, doctor, and test endpoints remain available
- if maintenance state cannot be read, the guard fails open to avoid turning a
  transient database issue into a full self-host lockout

## Admin Panel Contract

Admin surfaces now read the same planner:

- `GET /admin/updates` renders the current plan for admins.
- `GET /admin/updates/{runId}` renders a run detail view and event timeline
  for admins.
- `GET /api/admin/updates?action=check` returns `{ check }`.
- `GET /api/admin/updates?action=plan` returns `{ plan }`.
- `GET /api/admin/updates?action=history` returns `{ runs }`.
- `GET /api/admin/updates?action=run&id=<runId>` returns `{ run }`.
- `GET /api/admin/maintenance` returns `{ maintenance }`.
- `PATCH /api/admin/maintenance` updates maintenance mode.
- `POST /api/admin/updates` with `action=dry-run` returns the runner preview
  and worker plan.
- `POST /api/admin/updates` with `action=apply|rollback` previews by default;
  execution requires `execute: true` and every documented server-side gate.
- `POST /api/admin/updates` with `action=verify-backup` verifies the configured
  backup manifest.
- CLI check: `lfctl update check --json`
- CLI preview: `lfctl update plan --json`
- CLI backup gate: `lfctl backup verify --json`
- Apply update: only after backup verification and explicit admin confirmation.
- Major upgrade: require a second confirmation.

The admin Updates page includes a guarded control panel:

- `Preview` posts a dry-run/apply/rollback preview without execution.
- `Execute` remains disabled until the admin selects apply/rollback, checks
  admin confirmation, checks major-upgrade confirmation when needed, types
  `EXECUTE`, and the page sees maintenance mode plus verified signature.
- The API still enforces the server-side policy independently of the UI.
- Successful execution responses link to the update run detail timeline.

Auto-update remains off by default.
