const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("./server");

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "tickets");
});

test("POST /tickets creates a ticket with a receiptId", async () => {
  const res = await request(app).post("/tickets").send({ eventId: 1, userId: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.eventId, 1);
  assert.equal(res.body.userId, 1);
  assert.ok(res.body.receiptId);
});

test("POST /tickets with missing eventId/userId returns 400", async () => {
  const res = await request(app).post("/tickets").send({});
  assert.equal(res.status, 400);
});

test("GET /tickets lists created tickets", async () => {
  await request(app).post("/tickets").send({ eventId: 2, userId: 2 });
  const res = await request(app).get("/tickets");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});
