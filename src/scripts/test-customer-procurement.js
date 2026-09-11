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

const ACCESS_SECRET = "procurement-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "procurement-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "procurement-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "procurement-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "procurement-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_procurement_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `procurement_test_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: ProcurementRequest } = await import("../models/ProcurementRequest.js"));
  ({ default: ProcurementQuotation } = await import("../models/ProcurementQuotation.js"));
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

test("procurement request validation, organization types, idempotency, updates, and non-enumeration", async () => {
  const customerId = id();

  const invalidBudgetRes = await request(app)
    .post("/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-proc-bad")
    .send({
      organisationName: "Tech Corp",
      organisationType: "business",
      contactName: "John",
      contactEmail: "john@techcorp.com",
      contactPhone: "08012345678",
      requirements: [{ category: "Laptops", quantity: 5, minimumSpecifications: "Core i7" }],
      budgetMin: 500000,
      budgetMax: 200000,
    });
  assert.equal(invalidBudgetRes.status, 400);

  const createRes = await request(app)
    .post("/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-proc-1")
    .send({
      organisationName: "Greenwood High School",
      organisationType: "school",
      contactName: "Mary Principal",
      contactEmail: "mary@greenwood.edu",
      contactPhone: "08098765432",
      requirements: [{ category: "Desktop PCs", quantity: 20, minimumSpecifications: "Core i5 16GB RAM" }],
      budgetMin: 1000000,
      budgetMax: 3000000,
      fulfilmentMode: "delivery",
    });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "SUBMITTED");

  const replayRes = await request(app)
    .post("/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-proc-1")
    .send({
      organisationName: "Greenwood High School",
      organisationType: "school",
      contactName: "Mary Principal",
      contactEmail: "mary@greenwood.edu",
      contactPhone: "08098765432",
      requirements: [{ category: "Desktop PCs", quantity: 20, minimumSpecifications: "Core i5 16GB RAM" }],
      budgetMin: 1000000,
      budgetMax: 3000000,
      fulfilmentMode: "delivery",
    });
  assert.equal(replayRes.status, 201);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);

  const conflictRes = await request(app)
    .post("/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-proc-1")
    .send({
      organisationName: "Different Corp",
      organisationType: "business",
      contactName: "John",
      contactEmail: "john@different.com",
      contactPhone: "08012345678",
      requirements: [{ category: "Laptops", quantity: 1, minimumSpecifications: "Core i3" }],
    });
  assert.equal(conflictRes.status, 409);

  const requestId = createRes.body.data.id;
  const updateRes = await request(app)
    .patch(`/api/procurement/requests/${requestId}`)
    .set(auth(customerId))
    .send({ organisationName: "Greenwood Academy", notes: "Updated delivery location details" });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.data.organisationName, "Greenwood Academy");
  assert.equal(updateRes.body.data.version, 2);

  const foreignRes = await request(app).get(`/api/procurement/requests/${requestId}`).set(auth(id()));
  assert.equal(foreignRes.status, 404);
  assert.equal(foreignRes.body.errors[0].code, "procurement_request_unavailable");
});

test("procurement quotation staff issuance, versioning, customer decisions, and concurrency protection", async () => {
  const customerId = id();
  const staffId = id();

  const createReqRes = await request(app)
    .post("/api/procurement/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-proc-quote-req")
    .send({
      organisationName: "Global Non-profit",
      organisationType: "nonprofit",
      contactName: "Sarah Director",
      contactEmail: "sarah@global.org",
      contactPhone: "08022223333",
      requirements: [{ category: "Refurbished Laptops", quantity: 10, minimumSpecifications: "Core i5 8GB RAM" }],
    });
  const requestId = createReqRes.body.data.id;

  const staffQuote1Res = await request(app)
    .post(`/api/procurement/requests/${requestId}/quotations`)
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "10x Refurbished Laptops Grade A", quantity: 10, unitPrice: 150000, totalAmount: 1500000 }],
      subtotal: 1500000,
      tax: 112500,
      fees: 0,
      fulfilmentCharge: 20000,
      totalAmount: 1632500,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      termsVersion: "2026-08-quote-terms",
    });
  assert.equal(staffQuote1Res.status, 201);
  assert.equal(staffQuote1Res.body.data.version, 1);
  const quote1Id = staffQuote1Res.body.data.id;

  const staffQuote2Res = await request(app)
    .post(`/api/procurement/requests/${requestId}/quotations`)
    .set(auth(staffId, "ops_manager"))
    .send({
      lineItems: [{ description: "10x Refurbished Laptops Grade A + Bags", quantity: 10, unitPrice: 155000, totalAmount: 1550000 }],
      subtotal: 1550000,
      tax: 116250,
      fees: 0,
      fulfilmentCharge: 0,
      totalAmount: 1666250,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      termsVersion: "2026-08-quote-terms",
    });
  assert.equal(staffQuote2Res.status, 201);
  assert.equal(staffQuote2Res.body.data.version, 2);
  const quote2Id = staffQuote2Res.body.data.id;

  const approveSupersededRes = await request(app)
    .post(`/api/procurement/quotations/${quote1Id}/approve`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-approve-v1")
    .send({ version: 1 });
  assert.equal(approveSupersededRes.status, 409);
  assert.equal(approveSupersededRes.body.errors[0].code, "procurement_quote_not_actionable");

  const approveV2Res = await request(app)
    .post(`/api/procurement/quotations/${quote2Id}/approve`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-approve-v2")
    .send({ version: 2 });
  assert.equal(approveV2Res.status, 200);
  assert.equal(approveV2Res.body.data.status, "APPROVED");

  const replayApproveRes = await request(app)
    .post(`/api/procurement/quotations/${quote2Id}/approve`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-approve-v2")
    .send({ version: 2 });
  assert.equal(replayApproveRes.status, 200);

  const declineApprovedRes = await request(app)
    .post(`/api/procurement/quotations/${quote2Id}/decline`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-decline-v2")
    .send({ version: 2 });
  assert.equal(declineApprovedRes.status, 409);

  const notif = await Notification.findOne({ recipient: customerId, type: "procurement_quotation_issued" });
  assert.ok(notif);
});
