# 30 — Logging & Monitoring

## Overview

Structured logging, error tracking, and monitoring are essential for debugging, auditing, and operational health. This document defines the logging architecture.

## Logging Stack

| Component | Tool | Purpose |
|---|---|---|
| Server logging | **Pino** | Structured JSON logging, fast, low overhead |
| Client error tracking | **Custom error boundary + API reporting** | Catch and report client errors |
| Log aggregation (future) | **Loki + Grafana** or **Docker log driver** | Centralized log search |

### Why Pino?

- 5-10x faster than Winston (benchmarks)
- JSON output by default — machine-parseable
- Low memory overhead
- Great Next.js integration
- `pino-pretty` for human-readable dev output

## Server-Side Logging

### Configuration

```ts
// packages/core/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,  // JSON in production
  base: {
    service: 'lobbyforge-web',
    version: process.env.APP_VERSION || 'dev',
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
```

### Log Levels

| Level | When | Example |
|---|---|---|
| `fatal` | Process must exit | Uncaught exception, DB connection permanently lost |
| `error` | Operation failed | API handler error, failed LiveKit connection |
| `warn` | Potential problem | Rate limit hit, deprecated API usage, high memory |
| `info` | Normal operation | Server started, user logged in, game session created |
| `debug` | Detailed flow | SQL query, Redis operation, WebSocket message |
| `trace` | Very verbose | Request/response bodies, state machine transitions |

### Structured Log Format

```json
{
  "level": 30,
  "time": 1672531200000,
  "service": "lobbyforge-web",
  "msg": "User logged in",
  "userId": "uuid",
  "email": "u***@example.com",
  "method": "local",
  "ip": "192.168.1.x",
  "duration": 45
}
```

### What to Log

| Event | Level | Sensitive Data Handling |
|---|---|---|
| Server start/stop | info | — |
| User login/logout | info | Email masked |
| Failed login attempt | warn | Email masked, IP logged |
| API request (slow >1s) | warn | Path, duration, userId |
| API error (4xx) | warn | Path, error code, userId |
| API error (5xx) | error | Path, error, stack trace |
| DB query (slow >500ms) | warn | Query (no params), duration |
| Game session start/end | info | SessionId, pluginId, playerCount |
| Plugin error | error | PluginId, error, state snapshot |
| Rate limit triggered | warn | UserId, IP, endpoint |
| Permission denied | warn | UserId, attempted action |
| File upload | info | UserId, fileType, size |

### Sensitive Data Rules

**NEVER log:**
- Passwords or password hashes
- Session tokens
- API keys/secrets
- Full email addresses (mask: `u***@example.com`)
- Message content (privacy)
- Credit card / payment data

**ALWAYS log:**
- User IDs (for tracing)
- IP addresses (for security, with retention policy)
- Action type and result
- Error stack traces (server-side only)

## Client-Side Error Handling

### React Error Boundary

```tsx
// apps/web/src/components/ErrorBoundary.tsx
class ErrorBoundary extends React.Component {
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Report to server
    fetch('/api/errors/report', {
      method: 'POST',
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        url: window.location.href,
        timestamp: new Date().toISOString(),
      }),
    });
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}
```

### Global Error Handlers

```ts
// apps/web/src/lib/error-reporter.ts
window.addEventListener('unhandledrejection', (event) => {
  reportError({ type: 'unhandled_rejection', error: event.reason });
});

window.addEventListener('error', (event) => {
  reportError({ type: 'uncaught_error', error: event.error });
});
```

## Log Management in Production

### Docker Log Configuration

```yaml
# docker-compose.prod.yml
services:
  web:
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

### Log Access

```bash
# View logs
docker compose logs -f web
docker compose logs --since 1h web

# Search logs (JSON)
docker compose logs web | jq 'select(.level >= 40)'  # warn and above
docker compose logs web | jq 'select(.msg | contains("login"))'
```

### Future: Centralized Logging

For multi-instance or advanced setups:
- **Loki + Grafana:** Lightweight, Docker-native, good for self-hosted
- **Docker log driver → Loki:** No sidecar needed
- **Grafana dashboards:** Error rate, response times, active users, game sessions

## Request Tracing

### Request ID

Every request gets a unique ID for tracing:

```ts
// middleware.ts
export function middleware(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);

  // Add to logger context
  const childLogger = logger.child({ requestId });
  // ... attach to request context
}
```

Nginx passes through request ID:
```nginx
proxy_set_header X-Request-Id $request_id;
```

### Correlation

A single user action may touch multiple services:
```
Client action → API (requestId: abc) → Redis → PostgreSQL → LiveKit webhook
                                                              (requestId: abc)
```

All log entries share the same `requestId` for correlation.

## Health Metrics (Exposed Endpoints)

```
GET /api/health          → { status: 'ok', uptime: 123456 }
GET /api/health/ready     → { postgres: 'ok', redis: 'ok', livekit: 'ok' }
GET /api/health/metrics   → Prometheus-format metrics (future)
```

### Key Metrics to Track

| Metric | Type | Purpose |
|---|---|---|
| `http_requests_total` | Counter | Request volume |
| `http_request_duration_ms` | Histogram | Response time distribution |
| `http_errors_total` | Counter | Error rate |
| `active_sse_connections` | Gauge | SSE connection count |
| `active_voice_rooms` | Gauge | LiveKit room count |
| `active_game_sessions` | Gauge | Running game count |
| `db_query_duration_ms` | Histogram | Database performance |
| `redis_operations_total` | Counter | Redis usage |
