import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let GuidanceSession;
let GuidanceEscalation;
let Product;
let Variant;
let replicaSet;

const ACCESS_SECRET = "guidance-access-secret-32-characters-long";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "guidance-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "guidance-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "guidance-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET =
    "guidance-token-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_guidance_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `guidance_test_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: GuidanceSession } = await import("../models/GuidanceSession.js"));
  ({ default: GuidanceEscalation } =
    await import("../models/GuidanceEscalation.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));

  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. Guest session creation returns a secure resume token, encrypts digest, and rejects URL/body token leaks", async () => {
  const product = await Product.create({
    name: "Sanfaani Laptop",
    slug: "sanfaani-laptop",
    description: "Laptop",
    category: "computing",
    brand: "Sanfaani",
    status: "active",
  });
  await Variant.create({
    product: product._id,
    sku: "LAP-01",
    attributes: { ram: "16GB" },
    price: 150000,
    condition: "new",
    inStock: 5,
  });

  const guestCreateRes = await request(app)
    .post("/api/guidance")
    .send({ budget: 200000, useCase: "work", categories: ["computing"] });
  assert.equal(guestCreateRes.status, 201);
  assert.ok(guestCreateRes.body.data.resumeToken);

  const guestToken = guestCreateRes.body.data.resumeToken;
  const sessionId = guestCreateRes.body.data.session.id;

  // Verify Digest Cryptography (Raw token must NEVER touch the database)
  const rawDoc =
    await GuidanceSession.findById(sessionId).select("+resumeDigest");
  assert.ok(rawDoc.resumeDigest);
  assert.equal(JSON.stringify(rawDoc).includes(guestToken), false);

  // Valid Header Resume
  const guestResumeRes = await request(app)
    .get(`/api/guidance/${sessionId}`)
    .set("X-Guidance-Resume-Token", guestToken);
  assert.equal(guestResumeRes.status, 200);
  assert.equal(guestResumeRes.body.data.id, sessionId);

  // Prevent URL/Body Leakage (Middleware must only check headers)
  const queryTokenRes = await request(app).get(
    `/api/guidance/${sessionId}?token=${guestToken}`,
  );
  assert.equal(queryTokenRes.status, 404);
  const bodyTokenRes = await request(app)
    .get(`/api/guidance/${sessionId}`)
    .send({ token: guestToken });
  assert.equal(bodyTokenRes.status, 404);

  // Malformed Token Rejection
  const invalidTokenRes = await request(app)
    .get(`/api/guidance/${sessionId}`)
    .set("X-Guidance-Resume-Token", "invalid-token-value");
  assert.equal(invalidTokenRes.status, 404);
});

test("2. Authenticated sessions strictly enforce owner isolation and allow secure archival", async () => {
  const customerId = id();

  const ownerCreateRes = await request(app)
    .post("/api/guidance")
    .set(auth(customerId))
    .send({ budget: 200000, categories: ["computing"] });
  assert.equal(ownerCreateRes.status, 201);
  const ownerSessionId = ownerCreateRes.body.data.session.id;

  // Valid Owner Resume
  const ownerResumeRes = await request(app)
    .get(`/api/guidance/${ownerSessionId}`)
    .set(auth(customerId));
  assert.equal(ownerResumeRes.status, 200);

  // Foreign Owner Rejection
  const foreignResumeRes = await request(app)
    .get(`/api/guidance/${ownerSessionId}`)
    .set(auth(id()));
  assert.equal(foreignResumeRes.status, 404);

  // Archival
  const archiveRes = await request(app)
    .patch(`/api/guidance/${ownerSessionId}/archive`)
    .set(auth(customerId));
  assert.equal(archiveRes.status, 200);
  assert.equal(archiveRes.body.data.status, "ARCHIVED");
});

test("3. Escalation FSM correctly enforces customer/staff roles and blocks duplicate state creation", async () => {
  const customerId = id();
  const advisorId = id();

  const createRes = await request(app)
    .post("/api/guidance")
    .set(auth(customerId))
    .send({ budget: 100000, categories: ["phones"] });
  const sessionId = createRes.body.data.session.id;
  const guestToken = createRes.body.data.resumeToken;

  // Guest Cannot Escalate (Requires strict authentication)
  const guestEscalateRes = await request(app)
    .post(`/api/guidance/${sessionId}/escalations`)
    .set("X-Guidance-Resume-Token", guestToken)
    .send({ question: "Is this model compatible with 5G?" });
  assert.equal(guestEscalateRes.status, 401);

  // Owner Escalates
  const ownerEscalateRes = await request(app)
    .post(`/api/guidance/${sessionId}/escalations`)
    .set(auth(customerId))
    .send({
      question: "Is this model compatible with 5G networks in Nigeria?",
    });
  assert.equal(ownerEscalateRes.status, 201);
  assert.equal(ownerEscalateRes.body.data.status, "submitted");
  const escalationId = ownerEscalateRes.body.data.id;

  // Customer cannot jump roles to respond
  const customerRespondRes = await request(app)
    .post(`/api/guidance/escalations/${escalationId}/respond`)
    .set(auth(customerId, "customer"))
    .send({ response: "Customer trying to respond to advisor endpoint." });
  assert.equal(customerRespondRes.status, 403);

  // Advisor responds and resolves the escalation
  const advisorRespondRes = await request(app)
    .post(`/api/guidance/escalations/${escalationId}/respond`)
    .set(auth(advisorId, "sales_advisor"))
    .send({
      response: "Yes, this model supports 5G band N78.",
      displayName: "Sales Advisor Alex",
    });
  assert.equal(advisorRespondRes.status, 200);
});

test("4. Concurrent duplicate escalation requests strictly enforce the 'one active' rule via DB unique index", async () => {
  const customerId = id();

  const sessionRes = await request(app)
    .post("/api/guidance")
    .set(auth(customerId))
    .send({ budget: 200000 });
  const sessionId = sessionRes.body.data.session.id;

  // Two clicks at the exact same millisecond
  const [res1, res2] = await Promise.all([
    request(app)
      .post(`/api/guidance/${sessionId}/escalations`)
      .set(auth(customerId))
      .send({ question: "Double click question?" }),
    request(app)
      .post(`/api/guidance/${sessionId}/escalations`)
      .set(auth(customerId))
      .send({ question: "Double click question?" }),
  ]);

  // One MUST succeed (201), the other MUST hit the unique index block (409)
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  // Database must accurately reflect the winner
  const dbCount = await GuidanceEscalation.countDocuments({
    guidanceSession: sessionId,
    active: true,
  });
  assert.equal(dbCount, 1);
});
