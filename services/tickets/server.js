const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
