const express = require('express');
const app = express();

// Parse application/json bodies
app.use(express.json());

// Mock in-memory state to track performance/concurrency issues
let activeConnections = 0;
const DB_SIMULATION_THRESHOLD = 15; // Saturation gate triggers above 15 VU concurrent connections

// Enhanced Request Logging Middleware for Deep Test-Runner Visibility
app.use((req, res, next) => {
  activeConnections++;
  
  // High-visibility timestamp logging to track precise request arrival profiles
  console.log(`[REQUEST] ${new Date().toISOString()} - ${req.method} ${req.url} | Active Connections: ${activeConnections}`);
  
  res.on('finish', () => { 
    activeConnections--; 
    console.log(`[RESPONSE] ${new Date().toISOString()} - ${req.method} ${req.url} -> Completed with Status ${res.statusCode} | Remaining Conns: ${activeConnections}`);
  });
  next();
});

/**
 * 1. HIGH RISK: Authentication & Token Exchange
 * Fixed: Accepts automated frameworks passing 'undefined' parameters or dynamic user session strings.
 * Test Toggles: Pass ?crash=true or ?simulate_load=true to induce faults on command.
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  console.log(`[AUTH-ATTEMPT] Payload Username: "${username || 'none'}"`);

  // Controlled failure hooks replacing completely random crashes
  const shouldCrash = req.query.crash === 'true' || (req.query.simulate_load === 'true' && Math.random() < 0.05);
  if (shouldCrash) {
    console.error(`[ERROR 500] CryptoWorkerPool failed to sign JWT payload structure.`);
    return res.status(500).json({ 
      error: "Internal Server Error", 
      message: "CryptoWorkerPool failed to sign JWT payload structure." 
    });
  }

  // Permissive rule matrix to support baseline setup functions alongside local environments
  const isValidAdmin = username === 'admin' && password === 'secret';
  const isValidTestVU = username === 'testuser' || username === 'test' || (username && username.startsWith('vu'));
  const isProjectJContext = username === 'ajaia_vqbkaoz' || (username && username.startsWith('loadtest'));
  const isEmptySetupProbe = !username || username === 'none'; // Fallback for empty body probes

  if (isValidAdmin || isValidTestVU || isProjectJContext || isEmptySetupProbe) {
    return res.json({ 
      token: "phoenix-test-token-valid",
      issuedAt: new Date().toISOString()
    });
  }

  // Issue clear audit logs for actual unexpected authentication payloads
  console.warn(`[WARN 401] Unauthorized issued for username context: "${username}"`);
  return res.status(401).json({ error: "Unauthorized", message: "Invalid test credentials supplied." });
});

/**
 * 2. MEDIUM RISK: Business Critical User Directory & Search
 * Features: Heuristic concurrency gate evaluating downstream database simulation bottlenecks.
 */
app.get('/api/users', (req, res) => {
  // Optional flag to explicitly enforce token analysis headers passed by k6 loops
  const authHeader = req.headers['authorization'];
  if (req.query.require_auth === 'true' && (!authHeader || !authHeader.includes('phoenix-test-token-valid'))) {
    return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid bearer token." });
  }

  let delay = 100; // Base microsecond processing cost
  
  // Real-time capacity gate processing
  if (activeConnections > DB_SIMULATION_THRESHOLD) {
    console.warn(`[POOL-SATURATION] Active connections (${activeConnections}) breached saturation threshold (${DB_SIMULATION_THRESHOLD}). Inducing P95 latency fallback.`);
    delay = 6000; // 6-second timeout block to guarantee SLA / Threshold breach evaluations
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
 * 3. MEDIUM RISK: Transaction Checkout / Post Action
 * Features: Rejects mutations cleanly via 503 if lock queues exceed threshold limits.
 */
app.post('/api/checkout', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (req.query.require_auth === 'true' && (!authHeader || !authHeader.includes('phoenix-test-token-valid'))) {
    return res.status(401).json({ error: "Unauthorized", message: "Transaction blocked: Unauthenticated." });
  }

  // Induce transaction database locks intentionally under heavy loads or manual test parameters
  if (activeConnections > 10 || req.query.fail === 'true') {
    console.error(`[DB-MUTATION-LOCK] Active connections: ${activeConnections}. Write queue depth limit reached.`);
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database transaction lock queue depth exceeded limit."
    });
  }

  res.status(201).json({ status: "success", orderId: Math.floor(Math.random() * 100000) });
});

/**
 * 4. LOW RISK: Health & Readiness Subsystem
 * Great for execution engines running preflight environment checks.
 */
app.get('/health', (req, res) => {
  if (req.query.dead === 'true') {
    return res.status(502).json({ status: "DOWN", infrastructure: "unhealthy" });
  }
  res.status(200).json({ status: "UP", currentConnections: activeConnections });
});

// Server Initialization block
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`Phoenix Test Target API running on port ${PORT}`);
  console.log(`Permissive validation matrix & live logging enabled.`);
  console.log(`Ready for sustained multi-endpoint Project-J profiles.`);
  console.log(`===================================================`);
});