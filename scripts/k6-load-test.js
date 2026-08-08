/**
 * k6 load test for LobbyForge — simulates concurrent guest auth + presence.
 *
 * Usage:
 *   k6 run scripts/k6-load-test.js
 *
 * Prerequisites:
 *   - LobbyForge running locally (pnpm dev + docker compose dev stack)
 *   - k6 installed (https://k6.io)
 *
 * Scenarios:
 *   1. Guest creation burst — 50 concurrent guests in 10s.
 *   2. Presence heartbeat — sustained 30 VUs sending heartbeats for 1m.
 *   3. Lobby page load — 20 VUs loading /lobby in parallel.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

// Custom metrics
const guestCreationTime = new Trend('guest_creation_ms');
const presenceHeartbeatTime = new Trend('presence_heartbeat_ms');
const successRate = new Rate('successes');

export const options = {
  scenarios: {
    guest_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 20 },
        { duration: '10s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      exec: 'guestBurst',
    },
    presence_sustain: {
      executor: 'constant-vus',
      vus: 30,
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

// Generate unique guest display names per VU + iteration
function guestName() {
  return `LoadTest_${__VU}_${__ITER}`;
}

export function guestBurst() {
  const start = Date.now();
  const res = http.post(
    `${BASE}/api/auth/guest`,
    JSON.stringify({ displayNameSeed: guestName() }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  guestCreationTime.add(Date.now() - start);

  const ok = check(res, {
    'guest 200': (r) => r.status === 200,
    'has gid': (r) => {
      try { return JSON.parse(r.body).guest?.gid != null; } catch { return false; }
    },
  });
  successRate.add(ok);
  sleep(0.5);
}

export function presenceSustain() {
  // First create a guest session
  const guestRes = http.post(
    `${BASE}/api/auth/guest`,
    JSON.stringify({ displayNameSeed: guestName() }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const cookies = guestRes.cookies;
  if (!cookies?.lf_guest?.[0]?.value) {
    successRate.add(false);
    return;
  }

  const cookieStr = `lf_guest=${cookies.lf_guest[0].value}`;

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
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
      },
    }
  );
  presenceHeartbeatTime.add(Date.now() - start);

  // 403/404 is expected (no real membership) — we're measuring response time
  successRate.add(presenceRes.status >= 200 && presenceRes.status < 500);
  sleep(5); // 5s heartbeat interval
}
