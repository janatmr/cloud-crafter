// Triggered automatically by the S3 "receipt uploaded" event (see ../../scripts/setup.sh
// for the bucket notification wiring). No business logic beyond reading the event and
// calling Notifications — the Notifications service still owns notification creation.
const http = require("http");
const https = require("https");
const { URL } = require("url");

// NOTIFICATIONS_URL must resolve from wherever this Lambda container actually runs, not
// "localhost" (see spec §9.5 / Risk 3). NOTIFICATIONS_HOST_HEADER is only needed when
// NOTIFICATIONS_URL points at a host-based Ingress (e.g. the Minikube node IP) rather
// than a directly resolvable service address.
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL;
const NOTIFICATIONS_HOST_HEADER = process.env.NOTIFICATIONS_HOST_HEADER;

exports.handler = async (event) => {
  if (!NOTIFICATIONS_URL) {
    throw new Error("NOTIFICATIONS_URL is not configured");
  }

  const results = [];
  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const userId = extractUserId(key);
    const message = `Ticket receipt uploaded: ${key}`;

    console.log(`Processing S3 event for s3://${bucket}/${key}`);
    const response = await postNotification({ message, userId });
    console.log(`Notifications responded ${response.statusCode}`);
    results.push({ bucket, key, notified: response.statusCode === 201 });
  }

  return { statusCode: 200, processed: results };
};

function extractUserId(key) {
  const match = key.match(/user-(\d+)/);
  return match ? Number(match[1]) : null;
}

function postNotification(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(NOTIFICATIONS_URL);
    const body = JSON.stringify(payload);
    const client = url.protocol === "https:" ? https : http;

    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(NOTIFICATIONS_HOST_HEADER ? { Host: NOTIFICATIONS_HOST_HEADER } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
