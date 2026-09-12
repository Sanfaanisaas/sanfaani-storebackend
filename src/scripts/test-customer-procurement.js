import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let ProcurementRequest;
let ProcurementQuotation;
let Notification;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "procurement-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "procurement-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "procurement-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "procurement-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "procurement-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_procurement_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be13-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `procurement_test_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: ProcurementRequest } =
    await import("../models/ProcurementRequest.js"));
  ({ default: ProcurementQuotation } =
    await import("../models/ProcurementQuotation.js"));
  ({ default: Notification } = await import("../models/Notification.js"));

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

test("1. Request validation, idempotency, and organization types", async () => {
  const customerId = id();
  const idempotencyKey = next("proc-1");

  const invalidBudgetRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("proc-bad"))
    .send({
      organisationName: "Tech Corp",
      organisationType: "business",
      contactName: "John",
      contactEmail: "john@techcorp.com",
      contactPhone: "08012345678",
      requirements: [
        { category: "Laptops", quantity: 5, minimumSpecifications: "Core i7" },
      ],
      budgetMin: 500000,
      budgetMax: 200000, // Invalid: Min > Max
    });
  // Accepts either Zod's 422 or the Controller's 400
  assert.equal(
    [400, 422].includes(invalidBudgetRes.status),
    true,
    `Expected validation error, got ${invalidBudgetRes.status}`,
  );

  const payload = {
    organisationName: "Greenwood High School",
    organisationType: "school",
    contactName: "Mary Principal",
    contactEmail: "mary@greenwood.edu",
    contactPhone: "08098765432",
    requirements: [
      {
        category: "Desktop PCs",
        quantity: 20,
        minimumSpecifications: "Core i5 16GB RAM",
      },
    ],
    budgetMin: 1000000,
    budgetMax: 3000000,
    fulfilmentMode: "delivery",
  };

  // Valid Creation
  const createRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "SUBMITTED");

  // Idempotent Replay
  const replayRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
  assert.equal([200, 201].includes(replayRes.status), true);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);

  // Fingerprint Conflict
  const conflictRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send({ ...payload, organisationName: "Different Corp" });
  assert.equal(conflictRes.status, 409);
});

test("2. Optimistic Concurrency Control (OCC) and customer isolation on updates", async () => {
  const customerId = id();

  const createRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("occ"))
    .send({
      organisationName: "EduTrust",
      organisationType: "nonprofit",
      contactName: "Bob",
      contactEmail: "bob@edu.test",
      contactPhone: "123",
      requirements: [
        {
          category: "Desktops",
          quantity: 10,
          minimumSpecifications: "Core i5",
        },
      ],
    });

  const requestId = createRes.body.data.id;
  const currentVersion = createRes.body.data.version;

  // Launch two rapid-fire updates using the SAME version number
  const [res1, res2] = await Promise.all([
    req("patch", `/api/procurement/requests/${requestId}`)
      .set(auth(customerId))
      .send({ organisationName: "EduTrust 1", version: currentVersion }),
    req("patch", `/api/procurement/requests/${requestId}`)
      .set(auth(customerId))
      .send({ organisationName: "EduTrust 2", version: currentVersion }),
  ]);

  // One MUST succeed (200), one MUST fail the OCC check (409)
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const dbReq = await ProcurementRequest.findById(requestId);
  assert.equal(dbReq.version, currentVersion + 1);

  // Verify foreign access is strictly blocked
  const foreignRes = await req(
    "get",
    `/api/procurement/requests/${requestId}`,
  ).set(auth(id()));
  assert.equal(foreignRes.status, 404);
  assert.equal(
    foreignRes.body.errors[0].code,
    "procurement_request_unavailable",
  );
});

test("3. Clarification FSM strictly enforces responses and timeline histories", async () => {
  const customerId = id();

  // Directly seed a request in the clarification state
  const dbReq = await ProcurementRequest.create({
    customer: customerId,
    organisationName: "C",
    organisationType: "business",
    contactName: "C",
    contactEmail: "c@c.test",
    contactPhone: "1",
    requirements: [{ category: "A", quantity: 1, minimumSpecifications: "B" }],
    status: "CLARIFICATION_REQUIRED",
    clarifications: [{ question: "Do you need software installed?" }],
  });

  const clarificationId = dbReq.clarifications[0]._id;

  // Submit response
  const clarifyRes = await req(
    "post",
    `/api/procurement/requests/${dbReq._id}/clarifications/${clarificationId}`,
  )
    .set(auth(customerId))
    .send({ response: "Yes, please pre-install Windows." });

  assert.equal(clarifyRes.status, 200);
  assert.equal(clarifyRes.body.data.status, "UNDER_REVIEW");

  // Double-response blocked by FSM transition
  const duplicateRes = await req(
    "post",
    `/api/procurement/requests/${dbReq._id}/clarifications/${clarificationId}`,
  )
    .set(auth(customerId))
    .send({ response: "Wait, actually no." });
  assert.equal(duplicateRes.status, 409);
});

test("4. Quotation versioning supersedes older quotes and notifies customers", async () => {
  const customerId = id();
  const staffId = id();

  const reqRes = await req("post", "/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("quote-fsm"))
    .send({
      organisationName: "Global Non-profit",
      organisationType: "nonprofit",
      contactName: "Sarah Director",
      contactEmail: "sarah@global.org",
      contactPhone: "08022223333",
      requirements: [
        {
          category: "Refurbished Laptops",
          quantity: 10,
          minimumSpecifications: "Core i5 8GB RAM",
        },
      ],
    });
  const requestId = reqRes.body.data.id;

  // Staff issues V1 Quote
  const v1Res = await req(
    "post",
    `/api/procurement/requests/${requestId}/quotations`,
  )
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [
        {
          description: "10x Refurbished Laptops Grade A",
          quantity: 10,
          unitPrice: 150000,
          totalAmount: 1500000,
        },
      ],
      subtotal: 1500000,
      tax: 112500,
      fees: 0,
      fulfilmentCharge: 20000,
      totalAmount: 1632500,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      termsVersion: "2026-08",
    });
  assert.equal(v1Res.status, 201);
  assert.equal(v1Res.body.data.version, 1);
  const v1Id = v1Res.body.data.id;

  // Staff issues V2 Quote (Automatically superseding V1)
  const v2Res = await req(
    "post",
    `/api/procurement/requests/${requestId}/quotations`,
  )
    .set(auth(staffId, "ops_manager"))
    .send({
      lineItems: [
        {
          description: "10x Refurbished Laptops Grade A + Bags",
          quantity: 10,
          unitPrice: 155000,
          totalAmount: 1550000,
        },
      ],
      subtotal: 1550000,
      tax: 116250,
      fees: 0,
      fulfilmentCharge: 0,
      totalAmount: 1666250,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      termsVersion: "2026-08",
    });
  assert.equal(v2Res.status, 201);
  assert.equal(v2Res.body.data.version, 2);

  // Prove V1 cannot be approved because it was superseded
  const approveV1Res = await req(
    "post",
    `/api/procurement/quotations/${v1Id}/approve`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", next("app-v1"))
    .send({ version: 1 });
  assert.equal(approveV1Res.status, 409);
  assert.equal(
    approveV1Res.body.errors[0].code,
    "procurement_quote_not_actionable",
  );

  // Verify Notification
  const notifCount = await Notification.countDocuments({
    recipient: customerId,
    type: "procurement_quotation_issued",
  });
  assert.ok(notifCount >= 1);
});

test("5. MongoDB Transactions protect Quotation Decisions from concurrent race conditions", async () => {
  const customerId = id();

  // Seed Request and Quote directly to test decision phase
  const dbReq = await ProcurementRequest.create({
    customer: customerId,
    organisationName: "Corp",
    organisationType: "business",
    contactName: "D",
    contactEmail: "d@d.test",
    contactPhone: "1",
    requirements: [{ category: "X", quantity: 1, minimumSpecifications: "Y" }],
    status: "AWAITING_DECISION",
  });

  const dbQuote = await ProcurementQuotation.create({
    request: dbReq._id,
    customer: customerId,
    version: 1,
    isActionable: true,
    lineItems: [
      { description: "X", quantity: 1, unitPrice: 10, totalAmount: 10 },
    ],
    subtotal: 10,
    totalAmount: 10,
    validUntil: new Date(Date.now() + 86400000),
    termsVersion: "v1",
    status: "ISSUED",
  });

  // Launch two strictly conflicting decisions concurrently!
  // (Simulates customer clicking Approve and Decline at the exact same millisecond across two tabs)
  const [resApprove, resDecline] = await Promise.all([
    req("post", `/api/procurement/quotations/${dbQuote._id}/approve`)
      .set(auth(customerId))
      .set("Idempotency-Key", next("app"))
      .send({ version: 1 }),
    req("post", `/api/procurement/quotations/${dbQuote._id}/decline`)
      .set(auth(customerId))
      .set("Idempotency-Key", next("dec"))
      .send({ version: 1 }),
  ]);

  // The MongoDB `session.withTransaction` wrapper will catch the WriteConflict, retry,
  // see the quote is no longer ACTIONABLE (already decided by the winner), and safely throw a 409.
  const statuses = [resApprove.status, resDecline.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  // Database must only have ONE outcome cleanly synced across both models
  const finalQuote = await ProcurementQuotation.findById(dbQuote._id);
  const finalReq = await ProcurementRequest.findById(dbReq._id);

  assert.equal(["APPROVED", "DECLINED"].includes(finalQuote.status), true);
  assert.equal(finalQuote.isActionable, false);
  assert.equal(
    ["CONVERSION_PENDING", "DECLINED"].includes(finalReq.status),
    true,
  );

  // Idempotent replay of the winning decision must safely return 200 without changing state
  const winningDecision =
    finalQuote.status === "APPROVED" ? "approve" : "decline";
  const winningIdempotency = finalQuote.decision.idempotencyKey;

  const replayRes = await req(
    "post",
    `/api/procurement/quotations/${dbQuote._id}/${winningDecision}`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", winningIdempotency)
    .send({ version: 1 });
  assert.equal(replayRes.status, 200);
});
