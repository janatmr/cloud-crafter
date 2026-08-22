const express = require("express");
const client = require("prom-client");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Prometheus metrics (spec §23) — request count/duration/status code + default
// process metrics. Never includes secrets as label values.
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

// Demo notification log — in-memory, intentionally simple for the capstone starter.
// In Task 1 Part B, a serverless (LocalStack) trigger simulates calling this
// service automatically whenever a ticket receipt is generated.
let NOTIFICATIONS = [];

app.get("/health", (_req, res) => res.json({ status: "ok", service: "notifications" }));

app.get("/notifications", (_req, res) => res.json(NOTIFICATIONS));

app.post("/notify", (req, res) => {
  const { message, userId } = req.body || {};
  if (!message) return res.status(400).json({ error: "message is required" });

  const notification = { id: NOTIFICATIONS.length + 1, message, userId: userId || null, sentAt: new Date().toISOString() };
  NOTIFICATIONS.push(notification);
  console.log("Notification sent:", notification);
  res.status(201).json(notification);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Notifications service listening on port ${PORT}`));
}

module.exports = app;
