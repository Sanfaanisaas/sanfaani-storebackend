import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Warranty;
let Claim;
let Order;
let Repair;
let AuditLog;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "customer-warranties-access-secret-at-least-32-chars";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

const clear = async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
};

const seedWarranty = async (owner, overrides = {}) => {
  const order = await Order.create({
    userId: owner,
    items: [],
    subtotal: 1000,
    total: 1000,
    paymentMethod: "paystack",
    shippingAddress: {
      street: "1 Warranty Ave",
      city: "Lagos",
      state: "LA",
      country: "NG",
    },
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90); // Default active for 90 days

  const warranty = await Warranty.create({
    order: order._id,
    customer: owner,
    deviceSummary: "Test Device",
    status: "ACTIVE",
    claimAllowance: 1,
    expiresAt,
    ...overrides,
  });

  return { order, warranty };
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET =
    "customer-warranties-refresh-secret-at-least-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "customer-warranties-audit-secret-at-least-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_warranties_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(
    tmpdir(),
    "sanfaani-warranties-mongo",
  );

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `warranties_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Warranty } = await import("../models/Warranty.js"));
  ({ default: Claim } = await import("../models/Claim.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));

  await mongoose.syncIndexes();
});

test.beforeEach(clear);
test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. Owner can list and view their warranties, but foreign/malformed IDs return non-enumerating 404", async () => {
  const owner = id();
  const hacker = id();
  const { warranty } = await seedWarranty(owner);

  // List
  const listRes = await req("get", "/api/warranties/mine").set(auth(owner));
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.data.warranties.length, 1);
  assert.equal(listRes.body.data.warranties[0].id, warranty._id.toString());

  // Detail
  const detailRes = await req("get", `/api/warranties/${warranty._id}`).set(
    auth(owner),
  );
  assert.equal(detailRes.status, 200);

  // Authorization Gates
  const wrongOwner = await req("get", `/api/warranties/${warranty._id}`).set(
    auth(hacker),
  );
  const malformed = await req("get", `/api/warranties/not-an-id`).set(
    auth(owner),
  );

  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.body.errors[0].code, "warranty_unavailable"); // Prevents enumeration
  // Accept Zod's 422, Mongoose/Controller's 400, or a silent 404
  assert.equal(
    [400, 404, 422].includes(malformed.status),
    true,
    `Expected 400/404/422 for malformed ID, got ${malformed.status}`,
  );
});

test("2. Warranty eligibility accurately projects ACTIVE, EXPIRED, VOID, and EXHAUSTED states", async () => {
  const owner = id();

  const now = new Date();
  const pastEffective = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
  const pastExpiry = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const futureExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { warranty: activeW } = await seedWarranty(owner, {
    expiresAt: futureExpiry,
  });
  const { warranty: expiredW } = await seedWarranty(owner, {
    effectiveAt: pastEffective,
    expiresAt: pastExpiry,
  });
  const { warranty: voidW } = await seedWarranty(owner, {
    status: "VOID",
    expiresAt: futureExpiry,
  });

  // Create a warranty with allowance 1, then insert 1 active claim to exhaust it
  const { warranty: exhaustedW } = await seedWarranty(owner, {
    claimAllowance: 1,
    expiresAt: futureExpiry,
  });
  await Claim.create({
    warranty: exhaustedW._id,
    submittedBy: owner,
    description: "Uses up the allowance",
    active: true,
    idempotencyKey: next("exhaust"),
    idempotencyFingerprint: "a".repeat(64), // Valid 64-char hex to pass Zod/Mongoose
  });

  const tests = [
    { w: activeW, expectedStatus: "active", eligible: true },
    { w: expiredW, expectedStatus: "expired", eligible: false },
    { w: voidW, expectedStatus: "void", eligible: false },
    { w: exhaustedW, expectedStatus: "exhausted", eligible: false },
  ];

  for (const t of tests) {
    const res = await req("get", `/api/warranties/${t.w._id}/eligibility`).set(
      auth(owner),
    );
    assert.equal(
      res.status,
      200,
      `Expected 200, got ${res.status} for ${t.expectedStatus}`,
    );
    assert.equal(
      res.body.data.eligible,
      t.eligible,
      `Failed eligible check for ${t.expectedStatus}: expected ${t.eligible} got ${res.body.data.eligible}`,
    );
    if (!t.eligible) {
      assert.equal(res.body.data.reasonCode, t.expectedStatus.toUpperCase());
    }
  }
});

test("3. Claim creation strictly enforces idempotency and blocks fingerprint mismatches", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner);
  const idempotencyKey = next("claim-key");

  const payload1 = { description: "The screen is flickering randomly." };
  const payload2 = { description: "Different description entirely!" };

  // First request succeeds
  const first = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload1);
  assert.equal(first.status, 201);
  assert.equal(first.body.data.description, payload1.description);

  // Exact replay returns identical 201 response (Idempotent)
  const replay = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload1);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.id, first.body.data.id);

  // Same key, different payload fingerprint -> 409 Conflict
  const conflict = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload2);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.errors[0].code, "claim_idempotency_conflict");
});

test("4. Concurrent claim creations are caught by the 'one_active_claim_per_warranty' DB index", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner);

  // Launch 3 requests at the exact same millisecond with different idempotency keys
  const payloads = [
    { key: next("k1"), description: "Concurrent 1" },
    { key: next("k2"), description: "Concurrent 2" },
    { key: next("k3"), description: "Concurrent 3" },
  ];

  const results = await Promise.all(
    payloads.map((p) =>
      req("post", `/api/warranties/${warranty._id}/claims`)
        .set(auth(owner))
        .set("Idempotency-Key", p.key)
        .send({ description: p.description }),
    ),
  );

  // Exactly ONE must succeed (201), the rest must fail due to the DB transaction / unique index (409)
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);

  // Ensure DB strictly has 1 claim
  assert.equal(await Claim.countDocuments({ warranty: warranty._id }), 1);
});

test("5. A warranty cannot create a claim if its allowance is exhausted", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner, { claimAllowance: 1 });

  // Create first claim (Consumes allowance)
  const first = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", next("claim"))
    .send({ description: "Valid claim" });
  assert.equal(first.status, 201);

  // Attempt second claim
  const second = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", next("claim"))
    .send({ description: "Second claim" });

  assert.equal(second.status, 409);
  assert.equal(second.body.errors[0].code, "claim_ineligible"); // Ensure we check for ineligible due to allowance
});
