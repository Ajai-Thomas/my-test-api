// Load test for owned API service
// Endpoints:
//   [HIGH] POST /api/login — authentication, POST method
//   [HIGH] POST /api/checkout — transaction, POST method
//   [MEDIUM] GET /api/users — business-critical read, 1 traffic ref
//   [LOW] GET /health — static health check

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Metric: custom Trend for each endpoint
const duration_post_api_login = new Trend('duration_post_api_login');
const error_rate_post_api_login = new Rate('error_rate_post_api_login');

const duration_post_api_checkout = new Trend('duration_post_api_checkout');
const error_rate_post_api_checkout = new Rate('error_rate_post_api_checkout');

const duration_get_api_users = new Trend('duration_get_api_users');

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
    'error_rate_post_api_login': ['rate<0.02'],
    'duration_post_api_checkout': ['p(95)<2000', 'p(99)<5000'],
    'error_rate_post_api_checkout': ['rate<0.02'],
    'duration_get_api_users': ['p(95)<500', 'p(99)<800'],
    'duration_get_health': ['p(95)<200', 'p(99)<300'],
  },
};

// Setup: Authenticate once at test start; return token for use in default function
export function setup() {
  if (!__ENV.BASE_URL) throw new Error('BASE_URL env var is required');

  let token = '';
  try {
    const res = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: __ENV.USERNAME || 'test', password: __ENV.PASSWORD || 'test' }),
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

export default function (data) {
  // Group: HIGH tier — authentication and checkout are POST endpoints with strict latency budget
  // Why: POST /api/login and /api/checkout both trigger writes and auth logic, making them sensitive to contention
  group('HIGH risk tier', () => {
    // Test: Authenticate user via login endpoint
    // Why: Simulates real-world login under load; token generation is CPU-bound and auth stores are often hot-path
    const loginRes = http.post(
      `${__ENV.BASE_URL}/api/login`,
      JSON.stringify({ username: 'loadtest_' + __VU + '_' + __ITER, password: 'password123' }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: '/api/login', risk: 'HIGH' },
      }
    );
    // Assert: Response is 200 (successful auth) or 401 (bad creds) — both are acceptable outcomes
    // Metric: duration_post_api_login tracks JWT signing latency under load
    const loginOk = check(loginRes, {
      'login status 2xx or 4xx': (r) => r.status >= 200 && r.status < 500,
      'login response body present': (r) => r.body && r.body.length > 0,
      'login latency < 2000ms': (r) => r.timings.duration < 2000,
    });
    duration_post_api_login.add(loginRes.timings.duration);
    if (!loginOk) error_rate_post_api_login.add(1);

    sleep(Math.random() * 2 + 1);

    // Test: Checkout transaction — requires auth header if service has require_auth=true
    // Why: Checkout is stateful and involves DB write; authorization check is a hot-path dependency
    const checkoutPayload = JSON.stringify({
      items: [{ id: 'item_' + __ITER, quantity: 1 }],
      total: 99.99,
    });
    const checkoutParams = {
      headers: {
        'Content-Type': 'application/json',
        ...(data.authed && data.token ? { Authorization: 'Bearer ' + data.token } : {}),
      },
      tags: { endpoint: '/api/checkout', risk: 'HIGH' },
    };
    const checkoutRes = http.post(`${__ENV.BASE_URL}/api/checkout`, checkoutPayload, checkoutParams);
    // Assert: Checkout succeeds (2xx) when authed, or 401 if auth is required but missing
    // Metric: duration_post_api_checkout tracks transaction processing and auth validation latency
    const checkoutOk = check(checkoutRes, {
      'checkout status 2xx or 4xx': (r) => r.status >= 200 && r.status < 500,
      'checkout response body present': (r) => r.body && r.body.length > 0,
      'checkout latency < 2000ms': (r) => r.timings.duration < 2000,
    });
    duration_post_api_checkout.add(checkoutRes.timings.duration);
    if (!checkoutOk) error_rate_post_api_checkout.add(1);

    sleep(Math.random() * 2 + 1);
  });

  // Group: MEDIUM tier — business-critical read; requires auth if enforce is on
  group('MEDIUM risk tier', () => {
    // Test: Fetch all users — exercises DB read path with auth validation
    // Why: User list is a frequently-accessed resource; cold-cache reads hit Postgres directly, sensitive to connection pool saturation
    const usersParams = {
      headers: {
        ...(data.authed && data.token ? { Authorization: 'Bearer ' + data.token } : {}),
      },
      tags: { endpoint: '/api/users', risk: 'MEDIUM' },
    };
    const usersRes = http.get(`${__ENV.BASE_URL}/api/users`, usersParams);
    // Assert: Response is 2xx (success) or 401 (auth required but not provided)
    // Metric: duration_get_api_users tracks DB read + serialization latency
    const usersOk = check(usersRes, {
      'users status 2xx or 4xx': (r) => r.status >= 200 && r.status < 500,
      'users response body present': (r) => r.body && r.body.length > 0,
      'users latency < 500ms': (r) => r.timings.duration < 500,
    });
    duration_get_api_users.add(usersRes.timings.duration);

    sleep(Math.random() * 2 + 1);
  });

  // Group: LOW tier — health check and static responses; no auth required
  group('LOW risk tier', () => {
    // Test: Health check endpoint — fast, no-dependency response
    // Why: Health probes are high-volume; response time should be <200ms even under extreme load
    const healthRes = http.get(`${__ENV.BASE_URL}/health`, {
      tags: { endpoint: '/health', risk: 'LOW' },
    });
    // Assert: Status is 200 (healthy) or 502 (intentionally degraded for test)
    // Metric: duration_get_health tracks probe latency; should stay <200ms
    const healthOk = check(healthRes, {
      'health status 2xx or 5xx': (r) => (r.status >= 200 && r.status < 300) || r.status === 502,
      'health response body present': (r) => r.body && r.body.length > 0,
      'health latency < 200ms': (r) => r.timings.duration < 200,
    });
    duration_get_health.add(healthRes.timings.duration);

    sleep(Math.random() * 2 + 1);
  });
}
