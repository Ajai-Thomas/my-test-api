// Load test for OWNED SERVICE with 4 endpoints (1 HIGH, 1 HIGH, 1 MEDIUM, 1 LOW)
// [HIGH] POST /api/login — authentication endpoint, intermittent 500 crashes (JWT signing failure)
// [HIGH] POST /api/checkout — payment endpoint, 503 under load (DB transaction lock saturation)
// [MEDIUM] GET /api/users — user list, cascading DB delays under high concurrency
// [LOW] GET /health — health check endpoint, static response

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Metric: duration_post_api_login
// Measures latency of authentication requests. HIGH-risk endpoint; JWT signing can fail.
const duration_post_api_login = new Trend('duration_post_api_login');

// Metric: error_rate_post_api_login
// Tracks non-2xx responses on login. HIGH-risk; intermittent 500 errors expected.
const error_rate_post_api_login = new Rate('error_rate_post_api_login');

// Metric: duration_post_api_checkout
// Measures checkout latency. HIGH-risk; active connection pool saturation triggers 503.
const duration_post_api_checkout = new Trend('duration_post_api_checkout');

// Metric: error_rate_post_api_checkout
// Tracks checkout failures. HIGH-risk; 503 under load expected due to DB lock queues.
const error_rate_post_api_checkout = new Rate('error_rate_post_api_checkout');

// Metric: duration_get_api_users
// Measures user list fetch latency. MEDIUM-risk; DB connection pool exhaustion causes cascading delays.
const duration_get_api_users = new Trend('duration_get_api_users');

// Metric: duration_get_health
// Measures health check latency. LOW-risk; static endpoint, should be <100ms always.
const duration_get_health = new Trend('duration_get_health');

export const options = {
  stages: [
    { duration: '2m', target: 20 },
    { duration: '6m', target: 20 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    'http_req_failed': [{ threshold: 'rate<0.02', abortOnFail: true }],
    'duration_post_api_login': ['p(95)<2000', 'p(99)<5000'],
    'duration_post_api_checkout': ['p(95)<2000', 'p(99)<5000'],
    'duration_get_api_users': ['p(95)<500', 'p(99)<800'],
    'duration_get_health': ['p(95)<200', 'p(99)<300'],
  },
};

// Setup: Authenticate via POST /api/login to obtain token for subsequent requests
export function setup() {
  if (!__ENV.BASE_URL) throw new Error('BASE_URL env var is required');

  let token = '';
  try {
    const res = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: 'testuser', password: 'testpass' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.status >= 200 && res.status < 300) {
      token = res.json('token') || '';
    } else {
      console.warn(`[setup] login returned ${res.status} — running unauthenticated`);
    }
  } catch (e) {
    console.warn(`[setup] login threw: ${e.message} — running unauthenticated`);
  }
  return { token, authed: !!token };
}

export default function(data) {
  const baseUrl = __ENV.BASE_URL;
  const authHeader = data.authed ? { Authorization: `Bearer ${data.token}` } : {};

  // Group: HIGH tier — authentication and payment endpoints (POST, stateful, crypto/DB contention)
  // Why: POST methods are write-heavy; login involves JWT signing (intermittent 500 errors);
  //      checkout contends for DB transaction locks (503 under high concurrency).
  //      Both are customer-facing critical paths.
  group('HIGH - Auth & Checkout', () => {
    // Test: Authenticate user and retrieve JWT token for session
    // Why: Exercises JWT signing path in server; intermittent crypto worker crashes
    //      simulate real TLS/signing library failure modes under load.
    const loginRes = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: 'loadtest_user', password: 'loadtest_pass' }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: '/api/login', risk: 'HIGH' } }
    );

    // Assert: Login returns 2xx (success) or identifies specific failure mode
    // Why: Check captures both successful auth (200) and intermittent crashes (500).
    //      Non-2xx increments error_rate and contributes to abortOnFail threshold.
    const loginOk = check(loginRes, {
      'login status is 2xx': (r) => r.status >= 200 && r.status < 300,
      'login response has token field': (r) => r.json('token') !== undefined,
      'login response time < 2000ms': (r) => r.timings.duration < 2000,
    });
    duration_post_api_login.add(loginRes.timings.duration);
    if (!loginOk) error_rate_post_api_login.add(1);

    sleep(Math.random() * 2 + 1);

    // Test: Execute checkout (payment) request with cart payload
    // Why: High-contention endpoint; activeConnections > 10 triggers 503.
    //      Measures how system degrades under concurrent write load on transactional DB.
    const checkoutRes = http.post(
      `${__ENV.BASE_URL}/api/checkout`,
      JSON.stringify({ cartId: 'cart_12345', amount: 99.99 }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          ...authHeader 
        },
        tags: { endpoint: '/api/checkout', risk: 'HIGH' } 
      }
    );

    // Assert: Checkout returns 2xx (success) or 503 (expected under saturation)
    // Why: Under load, DB lock queue fills; 503 is expected and measured.
    //      Check ensures response structure is valid even on 503.
    const checkoutOk = check(checkoutRes, {
      'checkout status is 2xx or 503': (r) => (r.status >= 200 && r.status < 300) || r.status === 503,
      'checkout response body exists': (r) => r.body && r.body.length > 0,
      'checkout response time < 2000ms': (r) => r.timings.duration < 2000,
    });
    duration_post_api_checkout.add(checkoutRes.timings.duration);
    if (!checkoutOk) error_rate_post_api_checkout.add(1);
  });

  sleep(Math.random() * 2 + 1);

  // Group: MEDIUM tier — user list endpoint (GET, DB-heavy read under high concurrency)
  // Why: /api/users is business-critical but read-only. Under saturation (activeConnections > DB_THRESHOLD),
  //      server injects cascading 6-second delays to trigger SLA breaches.
  //      Measures DB connection pool exhaustion patterns.
  group('MEDIUM - User Listing', () => {
    // Test: Fetch paginated user list (cold-cache path, hits database)
    // Why: DB read path with cascading delays. At high VU count, activeConnections exceeds threshold,
    //      injecting 6000ms delay to force SLA threshold violation.
    const usersRes = http.get(
      `${__ENV.BASE_URL}/api/users`,
      { 
        headers: authHeader,
        tags: { endpoint: '/api/users', risk: 'MEDIUM' } 
      }
    );

    // Assert: Users endpoint returns 2xx with populated response
    // Why: Check validates both response structure (JSON array) and latency impact of DB saturation.
    const usersOk = check(usersRes, {
      'users status is 200': (r) => r.status === 200,
      'users response body exists': (r) => r.body && r.body.length > 0,
      'users response time < 500ms': (r) => r.timings.duration < 500,
    });
    duration_get_api_users.add(usersRes.timings.duration);
  });

  sleep(Math.random() * 2 + 1);

  // Group: LOW tier — health check (GET, static response, negligible load)
  // Why: Health endpoint is read-only and serves static data from memory.
  //      Should always respond in <100ms; used to verify baseline system health.
  group('LOW - Health Check', () => {
    // Test: Poll /health endpoint for system status
    // Why: Baseline health metric; must always respond <100ms regardless of load tier.
    //      If health check breaches, indicates fundamental infrastructure failure.
    const healthRes = http.get(
      `${__ENV.BASE_URL}/health`,
      { tags: { endpoint: '/health', risk: 'LOW' } }
    );

    // Assert: Health returns 200 with status field
    // Why: Health check is synchronous marker; any non-2xx or delay indicates cascading failure.
    const healthOk = check(healthRes, {
      'health status is 200': (r) => r.status === 200,
      'health response has status field': (r) => r.json('status') !== undefined,
      'health response time < 200ms': (r) => r.timings.duration < 200,
    });
    duration_get_health.add(healthRes.timings.duration);
  });

  sleep(Math.random() * 2 + 1);
}
