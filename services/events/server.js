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

// Demo event store — in-memory, intentionally simple for the capstone starter.
let EVENTS = [
  { id: 1, name: "CloudCrafter Launch Night", date: "2026-09-12", venue: "Cairo Opera House" },
  { id: 2, name: "DevOps Summit", date: "2026-10-03", venue: "New Capital Conference Center" }
];
let nextId = 3;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "events" }));

app.get("/events", (_req, res) => res.json(EVENTS));

app.get("/events/:id", (req, res) => {
  const event = EVENTS.find(e => e.id === Number(req.params.id));
  if (!event) return res.status(404).json({ error: "event not found" });
  res.json(event);
});

app.post("/events", (req, res) => {
  const { name, date, venue } = req.body || {};
  if (!name || !date || !venue) {
    return res.status(400).json({ error: "name, date, and venue are required" });
  }
  const event = { id: nextId++, name, date, venue };
  EVENTS.push(event);
  res.status(201).json(event);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Events service listening on port ${PORT}`));
}

module.exports = app;
