const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("./server");

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "users");
});

test("POST /login with valid credentials returns a token", async () => {
  const res = await request(app).post("/login").send({ username: "demo", password: "demo123" });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, "string");
});

test("POST /login with invalid credentials returns 401", async () => {
  const res = await request(app).post("/login").send({ username: "demo", password: "wrong" });
  assert.equal(res.status, 401);
});

test("GET /protected with a valid token returns 200", async () => {
  const login = await request(app).post("/login").send({ username: "demo", password: "demo123" });
  const res = await request(app)
    .get("/protected")
    .set("Authorization", `Bearer ${login.body.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, "demo");
});

test("GET /protected with a missing token returns 401", async () => {
  const res = await request(app).get("/protected");
  assert.equal(res.status, 401);
});

test("GET /protected with an invalid token returns 403", async () => {
  const res = await request(app).get("/protected").set("Authorization", "Bearer not-a-real-token");
  assert.equal(res.status, 403);
});

test("GET /metrics exposes prometheus metrics without leaking key material", async () => {
  const res = await request(app).get("/metrics");
  assert.equal(res.status, 200);
  assert.match(res.text, /http_requests_total/);
  assert.doesNotMatch(res.text, /BEGIN (RSA )?PRIVATE KEY/);
});
