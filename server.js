const express = require('express');
const app = express();

// Parse application/json bodies
app.use(express.json());

// State tracker to dynamically cascade failures as VUs execute loops
let activeConnections = 0;

// High-visibility Request Interceptor
app.use((req, res, next) => {
  activeConnections++;
  console.log(`[STRESS-TRACK] ${req.method} ${req.url} | Live Concurrency Depth: ${activeConnections}`);
  
  res.on('finish', () => { 
    activeConnections--; 
  });
  next();
});

/**
 * 1. Endpoint: POST /api/login
 * Target SLO: Error rate < 5%
 * Test Behavior: Triggers structural crypto signing failures to deliberately spike error metrics.
 */
app.post('/api/login', (req, res) => {
  const { username } = req.body;

  // Let a few pre-flight verification or setup probe requests slide to avoid instant abort, 
  // then cause massive system flakiness as virtual users scale out.
  if (activeConnections > 2 || Math.random() < 0.35) {
    console.error(`[REGRESSION ALERT] Unhandled CryptoWorkerPool connection pool dropping payload signature calculation.`);
    return res.status(500).json({ 
      error: "Internal Server Error", 
      message: "CryptoWorkerPool failed to sign JWT payload structure due to internal memory pressure." 
    });
  }

  return res.json({ 
    token: "phoenix-test-token-valid",
    issuedAt: new Date().toISOString()
  });
});

/**
 * 2. Endpoint: GET /api/users
 * Target SLO: p95 latency < 500 ms, p99 latency < 800 ms
 * Test Behavior: Induces an unyielding 2.2-second blocking block to guarantee SLA breaches.
 */
app.get('/api/users', (req, res) => {
  // Hard latency gate designed to violate the 500ms/800ms boundaries checked by Project-J
  const artificialBottleneckDelay = 2200; 

  console.warn(`[LATENCY-WALL] Inducing database lock saturation simulation. Delaying response by ${artificialBottleneckDelay}ms.`);

  setTimeout(() => {
    res.json([
      { id: 1, name: "Ajai Thomas", role: "SRE" },
      { id: 2, name: "Phoenix Runner", role: "Agent" }
    ]);
  }, artificialBottleneckDelay);
});

/**
 * 3. Endpoint: POST /api/checkout
 * Target SLO: Error rate < 5%
 * Test Behavior: Drops mutating order commands via 503 to simulate deadlocked pools.
 */
app.post('/api/checkout', (req, res) => {
  // Imposes a database lock simulation to break transaction check metrics completely
  if (activeConnections > 1 || Math.random() < 0.40) {
    console.error(`[DB-MUTATION-LOCK] Thread pool saturation detected. Rejecting transaction write.`);
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database transaction lock queue depth exceeded limit. Mutate operation discarded."
    });
  }

  res.status(201).json({ status: "success", orderId: Math.floor(Math.random() * 100000) });
});

/**
 * 4. Endpoint: GET /health
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: "UP", currentConnections: activeConnections });
});

// Boot environment
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`Phoenix TARGET API - [REGRESSION/REGRESSION ENGINE ACTIVE]`);
  console.log(`Deliberately breaking Read Latency & Write Stability targets.`);
  console.log(`Listening on port ${PORT}...`);
  console.log(`===================================================`);
});