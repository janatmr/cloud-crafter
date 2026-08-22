const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("./server");

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "events");
});

test("GET /events returns a list", async () => {
  const res = await request(app).get("/events");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});

test("GET /events/:id returns the matching event", async () => {
  const res = await request(app).get("/events/1");
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 1);
});

test("GET /events/:id returns 404 for an unknown id", async () => {
  const res = await request(app).get("/events/999999");
  assert.equal(res.status, 404);
});

test("POST /events creates a new event", async () => {
  const res = await request(app)
    .post("/events")
    .send({ name: "Test Event", date: "2026-11-01", venue: "Test Venue" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "Test Event");
});

test("POST /events with missing fields returns 400", async () => {
  const res = await request(app).post("/events").send({ name: "Missing fields" });
  assert.equal(res.status, 400);
});

test("GET /metrics exposes prometheus metrics", async () => {
  const res = await request(app).get("/metrics");
  assert.equal(res.status, 200);
  assert.match(res.text, /http_requests_total/);
});
