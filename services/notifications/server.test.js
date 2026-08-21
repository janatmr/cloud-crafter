const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("./server");

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "notifications");
});

test("POST /notify creates a notification", async () => {
  const res = await request(app).post("/notify").send({ message: "Test message", userId: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.message, "Test message");
  assert.equal(res.body.userId, 1);
});

test("POST /notify with a missing message returns 400", async () => {
  const res = await request(app).post("/notify").send({ userId: 1 });
  assert.equal(res.status, 400);
});

test("GET /notifications lists created notifications", async () => {
  await request(app).post("/notify").send({ message: "Another message" });
  const res = await request(app).get("/notifications");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});
