const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const client = require("prom-client");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Prometheus metrics (spec §23) — request count/duration/status code + default
// process metrics. Never includes S3 credentials as label values.
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

// S3-compatible endpoint (LocalStack in this project) for uploading ticket receipts —
// see localstack/README section in the root README for the event flow this feeds.
// Left unconfigured, uploads are skipped so local dev/tests don't need LocalStack running.
const S3_ENDPOINT = process.env.S3_ENDPOINT || null;
const S3_BUCKET = process.env.S3_BUCKET || null;
const s3Client = S3_ENDPOINT && S3_BUCKET
  ? new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test"
      }
    })
  : null;

// Demo ticket store — in-memory, intentionally simple for the capstone starter.
let TICKETS = [];
let nextId = 1;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "tickets" }));

app.get("/tickets", (_req, res) => res.json(TICKETS));

async function uploadReceipt(ticket) {
  if (!s3Client) return;
  const key = `receipts/ticket-${ticket.id}-user-${ticket.userId}.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(ticket),
    ContentType: "application/json"
  }));
  console.log(`Receipt uploaded to s3://${S3_BUCKET}/${key}`);
}

// Books a ticket for an event and returns a receipt.
// The receiptId, once uploaded to S3, is what triggers the LocalStack Lambda ->
// Notifications event flow (Task 1 Part B).
app.post("/tickets", async (req, res) => {
  const { eventId, userId } = req.body || {};
  if (!eventId || !userId) {
    return res.status(400).json({ error: "eventId and userId are required" });
  }
  const ticket = {
    id: nextId++,
    eventId,
    userId,
    issuedAt: new Date().toISOString(),
    receiptId: `receipt-${Date.now()}`
  };
  TICKETS.push(ticket);
  try {
    await uploadReceipt(ticket);
  } catch (err) {
    console.error("Receipt upload failed:", err.message);
  }
  res.status(201).json(ticket);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Tickets service listening on port ${PORT}`));
}

module.exports = app;
