/**
 * k6 load test for LobbyForge — new guests + presence heartbeats.
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:19620 scripts/k6-load-test.js
 *
 * Target: BASE_URL, else LF_E2E_BASE_URL (the e2e scripts' variable), else
 * http://localhost:19520 (`pnpm dev`). Use the instance's PUBLIC origin: it
 * is sent as the Origin header, and the production image refuses a POST
 * without a matching one ("Missing request origin" / "Invalid request
 * origin"; LOBBYFORGE_APP_ORIGIN / NEXT_PUBLIC_BASE_URL declare it).
 *
 * Run it against a TEST stack started with LOBBYFORGE_CAPTCHA_PROVIDER=none.
 * Bot protection is on by default (docs/CAPTCHA.md): every NEW guest must
 * solve an ALTCHA proof of work — millions of PBKDF2 iterations. k6 cannot
 * load altcha-lib, a solver in k6's JavaScript runtime would take far too
 * long per guest, and it would load-test the solver rather than the server
 * anyway. setup() asks
 * /api/auth/captcha whether a challenge is required and stops the run with
 * an explanation when it is; a `captcha_required` answer mid-run does the
 * same.
 *
 * Limits that stay on with the challenge off (docs/CAPTCHA.md §7): one
 * address may create 30 guests a minute (POST /api/auth/guest), and new
 * guests are capped at 10 an hour per address — or 200 an hour for the
 * whole instance when it cannot tell clients apart (no
 * LOBBYFORGE_TRUSTED_PROXY), which is the case for a local stack. So the
 * run creates a bounded number of guests: GUESTS for the burst (default 20)
 * and one per presence VU (PRESENCE_VUS, default 10), reused for every
 * heartbeat. Between runs, clear the counters:
 *   redis-cli --scan --pattern '*rate-limit*' | xargs redis-cli del
 *
 * Scenarios:
 *   1. guest_burst — GUESTS new guests, created by up to 20 VUs at once.
 *   2. presence_sustain — PRESENCE_VUS VUs sending heartbeats every 5 s for 30 s.
 */

import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || __ENV.LF_E2E_BASE_URL || 'http://localhost:19520').replace(/\/+$/, '');
const GUESTS = Number(__ENV.GUESTS || 20);
const PRESENCE_VUS = Number(__ENV.PRESENCE_VUS || 10);

const JSON_POST = { headers: { 'Content-Type': 'application/json', Origin: BASE } };

const CAPTCHA_HELP =
  'Creating a guest needs a bot-protection challenge (ALTCHA), which this load test cannot solve. ' +
  'Run it against a test stack started with LOBBYFORGE_CAPTCHA_PROVIDER=none (docs/CAPTCHA.md §3.2).';

// Custom metrics
const guestCreationTime = new Trend('guest_creation_ms');
const presenceHeartbeatTime = new Trend('presence_heartbeat_ms');
const successRate = new Rate('successes');

export const options = {
  scenarios: {
    guest_burst: {
      executor: 'shared-iterations',
      vus: Math.max(1, Math.min(20, GUESTS)),
      iterations: GUESTS,
      maxDuration: '30s',
      exec: 'guestBurst',
    },
    presence_sustain: {
      executor: 'constant-vus',
      vus: PRESENCE_VUS,
      duration: '30s',
      exec: 'presenceSustain',
      startTime: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],        // <5% errors
    http_req_duration: ['p(95)<2000'],      // 95% under 2s
    guest_creation_ms: ['p(95)<500'],       // guest creation <500ms
  },
};

export function setup() {
  console.info(`LobbyForge load test against ${BASE}`);
  const res = http.get(`${BASE}/api/auth/captcha?surface=guest`);
  if (res.status !== 200) {
    exec.test.abort(`GET ${BASE}/api/auth/captcha answered HTTP ${res.status} — is BASE_URL a running LobbyForge?`);
  }
  let required = false;
  try {
    required = JSON.parse(res.body).required === true;
  } catch {
    exec.test.abort(`GET ${BASE}/api/auth/captcha did not answer JSON — is BASE_URL a running LobbyForge?`);
  }
  if (required) exec.test.abort(CAPTCHA_HELP);
}

// Generate unique guest display names per VU + iteration
function guestName() {
  return `LoadTest_${exec.scenario.name}_${__VU}_${__ITER}`;
}

/** POST /api/auth/guest without a cookie: a NEW guest. Stops the run on `captcha_required`. */
function createGuest() {
  const start = Date.now();
  const res = http.post(`${BASE}/api/auth/guest`, JSON.stringify({ displayNameSeed: guestName() }), JSON_POST);
  guestCreationTime.add(Date.now() - start);
  if (res.status === 400) {
    let error = '';
    try {
      error = JSON.parse(res.body).error;
    } catch {
      // not JSON — reported by the checks below
    }
    if (error === 'captcha_required') exec.test.abort(CAPTCHA_HELP);
  }
  if (res.status === 429) {
    console.error(
      'POST /api/auth/guest answered 429: the guest limits (30/min per address, 10–200 new guests/hour) are used up. ' +
        "Lower GUESTS / PRESENCE_VUS or clear the counters (redis-cli --scan --pattern '*rate-limit*' | xargs redis-cli del)."
    );
  }
  return res;
}

export function guestBurst() {
  const res = createGuest();
  const ok = check(res, {
    'guest 200': (r) => r.status === 200,
    'has gid': (r) => {
      try { return JSON.parse(r.body).guest?.gid != null; } catch { return false; }
    },
  });
  successRate.add(ok);
}

// One guest per presence VU, created on its first iteration and reused for
// every heartbeat — a real client keeps its session.
let presenceCookie = null;

export function presenceSustain() {
  if (!presenceCookie) {
    const guestRes = createGuest();
    const value = guestRes.cookies?.lf_guest?.[0]?.value;
    if (!value) {
      successRate.add(false);
      sleep(5);
      return;
    }
    presenceCookie = `lf_guest=${value}`;
  }

  // Send presence heartbeat to a test server/channel
  const start = Date.now();
  const presenceRes = http.post(
    `${BASE}/api/presence`,
    JSON.stringify({
      serverId: '00000000-0000-0000-0000-000000000090',
      channelId: '00000000-0000-0000-0000-000000000091',
      status: 'online',
    }),
    {
      headers: { ...JSON_POST.headers, Cookie: presenceCookie },
      // The test server/channel does not exist: 403/404 are expected answers.
      responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 403, 404),
    }
  );
  presenceHeartbeatTime.add(Date.now() - start);

  // 403/404 is expected (no real membership) — we're measuring response time
  successRate.add(presenceRes.status >= 200 && presenceRes.status < 500);
  sleep(5); // 5s heartbeat interval
}
