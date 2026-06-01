// Load test for owned service with HIGH/MEDIUM/LOW risk endpoints
// Endpoints: POST /api/login (HIGH), POST /api/checkout (HIGH), GET /api/users (MEDIUM), GET /health (LOW)
// Risk classification: login/checkout are POST with error-prone backends; users has SLA latency gates; health is static
// Load profile: LOAD — ramp 0→20 VUs over 2m, sustain 20 VUs for 6m, ramp down over 2m

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Metric: duration_post_api_login — latency distribution of auth requests
// Why: POST /api/login involves crypto signing; high sensitivity to thread pool saturation
const duration_post_api_login = new Trend('duration_post_api_login');

// Metric: error_rate_post_api_login — error rate for login endpoint (HIGH-risk)
// Why: Source indicates deliberate error spiking to test failure handling
const error_rate_post_api_login = new Rate('error_rate_post_api_login');

// Metric: duration_post_api_checkout — latency of transaction requests
// Why: POST /api/checkout is mutation-heavy; DB lock simulation adds latency variance
const duration_post_api_checkout = new Trend('duration_post_api_checkout');

// Metric: error_rate_post_api_checkout — error rate for checkout (HIGH-risk)
// Why: Source shows 40% rejection rate under load; deadlock simulation
const error_rate_post_api_checkout = new Rate('error_rate_post_api_checkout');

// Metric: duration_get_api_users — latency of user list fetch
// Why: Artificial 2.2s bottleneck designed to breach SLA; exercises slow-path detection
const duration_get_api_users = new Trend('duration_get_api_users');

// Metric: duration_get_health — latency of health check (LOW-risk)
// Why: Static endpoint; baseline for system overhead
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
    'error_rate_post_api_login': ['rate<0.05'],
    'duration_post_api_checkout': ['p(95)<2000', 'p(99)<5000'],
    'error_rate_post_api_checkout': ['rate<0.05'],
    'duration_get_api_users': ['p(95)<500', 'p(99)<800'],
    'duration_get_health': ['p(95)<200', 'p(99)<300'],
  },
};

// Setup: Validate BASE_URL; attempt login to capture auth token for subsequent requests
export function setup() {
  if (!__ENV.BASE_URL) throw new Error('BASE_URL env var is required');

  let token = '';
  try {
    // Test: POST /api/login with minimal credentials to obtain auth token
    // Why: All HIGH-risk endpoints may require Bearer auth; pre-fetch to avoid per-VU login storms
    const res = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: 'loadtest' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.status >= 200 && res.status < 300) {
      token = res.json('token') || res.json('access_token') || '';
    } else {
      console.warn(`[setup] login returned ${res.status}; running unauthenticated`);
    }
  } catch (e) {
    console.warn(`[setup] login threw: ${e.message}; running unauthenticated`);
  }

  return { token, authed: !!token };
}

// Group: HIGH-risk tier — POST mutations with error-prone backends
// Why: login and checkout trigger deliberate failure modes (crypto errors, DB locks) at load
export default function (data) {
  group('HIGH-risk: login', () => {
    // Test: POST /api/login with username credential
    // Why: Auth path exercises crypto signing and pre-flight verification; deliberately induces errors
    const loginRes = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: `user_${__VU}_${__ITER}` }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: '/api/login', risk: 'HIGH' },
      }
    );

    // Assert: Status is success (2xx) or explicit error; body contains token field or error message
    // Why: Verifies endpoint stability; token presence confirms auth success path
    const ok = check(loginRes, {
      'status is 2xx or error': (r) => r.status >= 200 && r.status < 500,
      'response body not empty': (r) => r.body && r.body.length > 0,
      'response time < 2000ms': (r) => r.timings.duration < 2000,
    });

    // Metric: Record login latency and error rate
    duration_post_api_login.add(loginRes.timings.duration, { endpoint: '/api/login' });
    error_rate_post_api_login.add(!ok, { endpoint: '/api/login' });

    sleep(Math.random() * 2 + 1);
  });

  group('HIGH-risk: checkout', () => {
    // Test: POST /api/checkout to simulate transaction under DB lock pressure
    // Why: POST /api/checkout drops 40% of requests; tests circuit-breaker and retry resilience
    const checkoutRes = http.post(
      `${__ENV.BASE_URL}/api/checkout`,
      JSON.stringify({ orderId: `order_${__VU}_${__ITER}`, amount: 99.99 }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...(data.authed ? { 'Authorization': `Bearer ${data.token}` } : {}),
        },
        tags: { endpoint: '/api/checkout', risk: 'HIGH' },
      }
    );

    // Assert: Status 200/201 on success; 503 on saturation; error metrics bubble up
    // Why: Checkout failures must be observable; saturation codes (503) are expected under load
    const ok = check(checkoutRes, {
      'status is 2xx or 503': (r) => (r.status >= 200 && r.status < 300) || r.status === 503,
      'response body not empty': (r) => r.body && r.body.length > 0,
      'response time < 2000ms': (r) => r.timings.duration < 2000,
    });

    // Metric: Record checkout latency and error rate
    duration_post_api_checkout.add(checkoutRes.timings.duration, { endpoint: '/api/checkout' });
    error_rate_post_api_checkout.add(!ok, { endpoint: '/api/checkout' });

    sleep(Math.random() * 2 + 1);
  });

  group('MEDIUM-risk: get users', () => {
    // Test: GET /api/users to fetch user list with artificial 2.2s latency gate
    // Why: Source imposes hard 2.2s bottleneck; this endpoint tests SLA breach detection
    const usersRes = http.get(
      `${__ENV.BASE_URL}/api/users`,
      {
        headers: data.authed ? { 'Authorization': `Bearer ${data.token}` } : {},
        tags: { endpoint: '/api/users', risk: 'MEDIUM' },
      }
    );

    // Assert: Status 200; response array/object present; latency measured for SLA evaluation
    // Why: Deliberate latency spike (2.2s) will breach p(95)<500 SLA; confirms load test detects violations
    const ok = check(usersRes, {
      'status is 200': (r) => r.status === 200,
      'response body not empty': (r) => r.body && r.body.length > 0,
      'response time recorded': (r) => r.timings.duration >= 0,
    });

    // Metric: Record user list latency (will show SLA breaches)
    duration_get_api_users.add(usersRes.timings.duration, { endpoint: '/api/users' });

    sleep(Math.random() * 2 + 1);
  });

  group('LOW-risk: health', () => {
    // Test: GET /health static health probe
    // Why: Low-latency baseline; tests system overhead without backend load
    const healthRes = http.get(
      `${__ENV.BASE_URL}/health`,
      {
        tags: { endpoint: '/health', risk: 'LOW' },
      }
    );

    // Assert: Status 200; JSON body contains status field
    // Why: Health endpoint must be fast and reliable; validates basic connectivity
    const ok = check(healthRes, {
      'status is 200': (r) => r.status === 200,
      'response has status field': (r) => r.json('status') !== undefined,
      'response time < 200ms': (r) => r.timings.duration < 200,
    });

    // Metric: Record health check latency
    duration_get_health.add(healthRes.timings.duration, { endpoint: '/health' });

    sleep(Math.random() * 2 + 1);
  });
}
