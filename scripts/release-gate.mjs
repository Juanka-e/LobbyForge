#!/usr/bin/env node
// Release gate — invoked by .github/workflows/release.yml (verify job).
// Waits until every required CI/security check context is COMPLETED on
// the tagged commit, then requires SUCCESS on all of them. A release
// cannot ship from a commit with a red, pending or missing check.
//
// EXPECTED_CHECKS is the single source of truth for what a release must
// be green on — keep it in sync with the job names in ci.yml and
// security.yml. A stale entry fails the gate as "missing" (fail-closed);
// renaming a job there requires renaming it here.
import process from 'node:process';

const EXPECTED_CHECKS = [
  // ci.yml
  'verify (ubuntu-latest)',
  'verify (windows-latest)',
  'Docker image build',
  'Production compose config',
  'e2e (production TLS edge)',
  'e2e (compose stack)',
  'Desktop shell (cargo check)',
  'Dependency audit (prod)',
  'DB migration integrity',
  // security.yml
  'Dependency audit (scheduled + push)',
  'Desktop Rust dependency audit (RustSec)',
  'CodeQL',
  'Container scan (Trivy)',
  'Third-party Trivy (nginx)',
  'Third-party Trivy (redis)',
  'Third-party Trivy (postgres)',
  'Third-party Trivy (livekit)',
  'Third-party Trivy (coturn)',
  'Third-party Trivy (certbot)',
];

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 70 * 60 * 1000;

const STATE_ORDER = ['ok', 'missing', 'pending', 'failed'];
function worstState(a, b) {
  return STATE_ORDER.indexOf(b) > STATE_ORDER.indexOf(a) ? b : a;
}

function evaluate(checkRuns) {
  // Check runs are per-SHA: a tag on an already-merged commit carries the
  // branch-triggered runs PLUS the tag-triggered ones — and GitHub's
  // per-ref concurrency groups can leave CANCELLED runs behind (rc.3
  // drill: the same SHA had a cancelled main-run and a green tag-run).
  // Rule per context: CANCELLED/SKIPPED runs are non-authoritative
  // (superseded, not a verdict). Among the remaining runs: wait while any
  // is non-completed, then require at least one success and NO
  // failure/timed_out — a real failure cannot be outvoted.
  const isAuthoritative = (run) => run.conclusion !== 'cancelled' && run.conclusion !== 'skipped';
  let state = 'ok';
  const detail = [];
  for (const name of EXPECTED_CHECKS) {
    const all = checkRuns.filter((run) => run.name === name);
    const mine = all.filter(isAuthoritative);
    let itemState;
    if (mine.length === 0) itemState = 'missing';
    else if (mine.some((run) => run.status !== 'completed')) itemState = 'pending';
    else if (
      mine.some((run) => run.conclusion === 'success') &&
      !mine.some((run) => run.conclusion === 'failure' || run.conclusion === 'timed_out')
    ) {
      itemState = 'ok';
    } else itemState = 'failed';
    state = worstState(state, itemState);
    detail.push({
      name,
      state: itemState,
      runs: all.map((run) => `${run.status}/${run.conclusion ?? '-'}`),
    });
  }
  return { state, detail };
}

async function fetchCheckRuns() {
  // Offline testing hook: GATE_CHECK_RUNS_FILE=<json> evaluates a local
  // check-runs payload once instead of polling the live API.
  if (process.env.GATE_CHECK_RUNS_FILE) {
    const { default: fs } = await import('node:fs/promises');
    const payload = JSON.parse(await fs.readFile(process.env.GATE_CHECK_RUNS_FILE, 'utf8'));
    return payload.check_runs ?? [];
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA must be set.');
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok) throw new Error(`check-runs API HTTP ${res.status}`);
  const body = await res.json();
  return body.check_runs ?? [];
}

function printDetail(evaluation) {
  for (const item of evaluation.detail) {
    const runs = item.runs.length ? `  [${item.runs.join(' ')}]` : '  (no runs)';
    console.log(`  ${item.state.padEnd(7)} ${item.name}${runs}`);
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  const offline = Boolean(process.env.GATE_CHECK_RUNS_FILE);
  let evaluation = null;
  while (true) {
    try {
      evaluation = evaluate(await fetchCheckRuns());
    } catch (err) {
      // Live mode: transient API failures keep polling until the
      // deadline. Offline mode (local test payload): polling can never
      // fix a bad payload — abort immediately instead of hanging.
      console.error(`check-runs fetch failed: ${err.message}`);
      if (offline) process.exit(1);
    }
    if (evaluation) {
      console.log(`check state: ${evaluation.state} (${new Date().toISOString()})`);
      // A completed failure is final — no point waiting for the rest.
      if (evaluation.state === 'ok' || evaluation.state === 'failed' || offline) break;
    }
    if (Date.now() >= deadline) {
      console.error('::error::Timed out waiting for required checks.');
      if (evaluation) printDetail(evaluation);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  printDetail(evaluation);
  if (evaluation.state !== 'ok') {
    console.error(`::error::Required checks not satisfied (state: ${evaluation.state}) — refusing to release.`);
    process.exit(1);
  }
  console.log('All required checks passed.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
