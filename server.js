const express = require('express');
const app = express();
app.use(express.json());

// Mock in-memory state to capture stress issues
let activeConnections = 0;
const DB_SIMULATION_THRESHOLD = 15; // Simulate pool saturation above 15 VU concurrent connections

// Enhanced Request Logging Middleware for Debugging Test Frameworks
app.use((req, res, next) => {
  activeConnections++;
  
  // Log request arrival for visibility into the test framework's behavior
  console.log(`[REQUEST] ${new Date().toISOString()} - ${req.method} ${req.url} | Active Conns: ${activeConnections}`);
  
  res.on('finish', () => { 
    activeConnections--; 
    console.log(`[RESPONSE] ${req.method} ${req.url} completed with status ${res.statusCode}`);
  });
  next();
});

/**
 * 1. Authentication & Token Exchange
 * Improvement: Supports multiple known credential patterns and fallback modes to allow 
 * smoke tests to pass, while maintaining toggle query hooks to test server failure paths.
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Log payload metadata to fix missing visibility gaps reported by test engineers
  console.log(`[AUTH-ATTEMPT] Username provided: "${username || 'none'}"`);

  // Controlled trigger for simulating JWT signing crashes (500 errors)
  // Can be hard-triggered via query parameter, or left at a low 5% random flake rate under load
  const shouldCrash = req.query.crash === 'true' || (req.query.simulate_load === 'true' && Math.random() < 0.05);
  if (shouldCrash) {
    console.error(`[ERROR] CryptoWorkerPool failed to sign JWT payload structure.`);
    return res.status(500).json({ 
      error: "Internal Server Error", 
      message: "CryptoWorkerPool failed to sign JWT payload structure." 
    });
  }

  // Broadened credential acceptance criteria to ensure k6 setup functions don't immediately stall
  const isValidAdmin = username === 'admin' && password === 'secret';
  const isValidTestVU = username === 'testuser' || username === 'test' || (username && username.startsWith('vu'));

  if (isValidAdmin || isValidTestVU) {
    return res.json({ 
      token: "phoenix-test-token-valid",
      issuedAt: new Date().toISOString()
    });
  }

  console.warn(`[WARN] 401 Unauthorized issued for user: "${username}"`);
  return res.status(401).json({ error: "Unauthorized", message: "Invalid test credentials supplied." });
});

/**
 * 2. Business Critical User Directory & Search
 */
app.get('/api/users', (req, res) => {
  // Check authorization token if passed by k6 main loop groups
  const authHeader = req.headers['authorization'];
  if (req.query.require_auth === 'true' && (!authHeader || !authHeader.includes('phoenix-test-token-valid'))) {
    return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid bearer token." });
  }

  let delay = 100; // Base delay
  
  // Degrades connection pooling as VU concurrent stress spikes
  if (activeConnections > DB_SIMULATION_THRESHOLD) {
    console.warn(`[POOL-SATURATION] Active connections (${activeConnections}) exceeded threshold (${DB_SIMULATION_THRESHOLD}). Inducing latency cascade.`);
    delay = 6000; // 6-second block to trigger SLA / Threshold breaches intentionally
  } else if (req.query.slow === 'true') {
    delay = 3500;
  }

  setTimeout(() => {
    res.json([
      { id: 1, name: "Ajai Thomas", role: "SRE" },
      { id: 2, name: "Phoenix Runner", role: "Agent" }
    ]);
  }, delay);
});

/**
 * 3. Transaction Checkout / Post Action
 */
app.post('/api/checkout', (req, res) => {
  // Validate that the request has an authorization context
  const authHeader = req.headers['authorization'];
  if (req.query.require_auth === 'true' && (!authHeader || !authHeader.includes('phoenix-test-token-valid'))) {
    return res.status(401).json({ error: "Unauthorized", message: "Transaction blocked: Unauthenticated." });
  }

  // Induce structural Service Unavailabilities under high connection depth or failure toggle flags
  if (activeConnections > 10 || req.query.fail === 'true') {
    console.error(`[DB-LOCK] Write queue depth limit reached. Rejecting transaction mutation.`);
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database transaction lock queue depth exceeded limit."
    });
  }

  res.status(201).json({ status: "success", orderId: Math.floor(Math.random() * 100000) });
});

/**
 * 4. Health & Readiness Subsystem
 * Useful for automated execution frameworks to perform a "pre-flight check" before launching load tests.
 */
app.get('/health', (req, res) => {
  if (req.query.dead === 'true') {
    return res.status(502).json({ status: "DOWN", infrastructure: "unhealthy" });
  }
  res.status(200).json({ status: "UP", activeConnections });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`Phoenix Test Target API running on port ${PORT}`);
  console.log(`Logs active for tracking Framework Setup parameters`);
  console.log(`===================================================`);
});