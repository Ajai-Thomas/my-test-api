const express = require('express');
const app = express();
app.use(express.json());

// Mock in-memory state to capture stress issues
let activeConnections = 0;
const DB_SIMULATION_THRESHOLD = 15; // Simulate pool saturation above 15 VU concurrent connections

// Middleware to track concurrent flight pressure
app.use((req, res, next) => {
  activeConnections++;
  res.on('finish', () => { activeConnections--; });
  next();
});

/**
 * 1. HIGH RISK: Authentication & Token Exchange
 * Intent: Test credential validation and simulate 500 crashes / 401 auth blocks
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Simulate an intermittent internal token signing crash (500 Internal Server Error)
  if (req.query.crash === 'true' || Math.random() < 0.15) {
    return res.status(500).json({ 
      error: "Internal Server Error", 
      message: "CryptoWorkerPool failed to sign JWT payload structure." 
    });
  }

  // Baseline standard credential challenge check
  if (username === 'admin' && password === 'secret') {
    return res.json({ token: "phoenix-test-token-valid" });
  }

  return res.status(401).json({ error: "Unauthorized", message: "Invalid test credentials supplied." });
});

/**
 * 2. MEDIUM RISK: Business Critical User Directory & Search
 * Intent: Trigger extreme latency cascading failures (P95/P99 breach) under high concurrency
 */
app.get('/api/users', async (req, res) => {
  // Heuristic saturation: As VUs ramp up, database connection pooling degrades exponentially
  let delay = 100; // Base delay
  
  if (activeConnections > DB_SIMULATION_THRESHOLD) {
    // Cascade delay when concurrent virtual user execution spikes
    delay = 6000; // 6-second timeout block to guarantee SLA / Threshold breach
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
 * Intent: Trigger high error frequency patterns on database write mutations
 */
app.post('/api/checkout', (req, res) => {
  // Induce structural 400 Bad Request patterns or 503 service unavailabilities
  if (activeConnections > 10 || req.query.fail === 'true') {
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database transaction lock queue depth exceeded limit."
    });
  }

  res.status(201).json({ status: "success", orderId: Math.floor(Math.random() * 100000) });
});

/**
 * 4. LOW RISK: Health & Readiness Subsystem
 * Intent: Remains healthy unless absolute complete server degradation occurs
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
  console.log(`Simulating Latency Gates and Connection Pool Droppers`);
  console.log(`===================================================`);
});