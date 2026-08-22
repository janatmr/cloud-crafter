const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const client = require("prom-client");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PRIVATE_KEY_PATH = process.env.JWT_PRIVATE_KEY_PATH || path.join(__dirname, "private.key");
const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH || path.join(__dirname, "public.key");
const PRIVATE_KEY = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
const PUBLIC_KEY = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");

// Prometheus metrics (spec §23) — request count/duration/status code + default
// process metrics. Never includes tokens, keys, or credentials as label values.
const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry]
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry]
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route ? req.baseUrl + req.route.path : req.path,
      status_code: res.statusCode
    };
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    httpRequestsTotal.inc(labels);
  });
  next();
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

// Demo user store — CloudCrafter is a learning project, this is intentionally in-memory.
const USERS = [
  { id: 1, username: "demo", password: "demo123", name: "Demo User" }
];

app.get("/health", (_req, res) => res.json({ status: "ok", service: "users" }));

app.get("/users", (_req, res) => {
  res.json(USERS.map(({ id, username, name }) => ({ id, username, name })));
});

// Issues a JWT signed with the current private key
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "invalid credentials" });

  const token = jwt.sign(
    { sub: user.id, username: user.username },
    PRIVATE_KEY,
    { algorithm: "RS256", expiresIn: "1h" }
  );
  res.json({ token });
});

// Verifies a JWT against the current public key — used to prove key rotation worked
app.get("/protected", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });

  try {
    const payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ["RS256"] });
    res.json({ message: "access granted", user: payload });
  } catch (err) {
    res.status(403).json({ error: "invalid or expired token", details: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Users service listening on port ${PORT}`));
}

module.exports = app;
