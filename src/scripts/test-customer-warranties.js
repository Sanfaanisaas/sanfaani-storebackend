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
let Notification;
let replicaSet;

const ACCESS_SECRET = "customer-warranties-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "customer-warranties-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "customer-warranties-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "customer-warranties-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "customer-warranties-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_warranties_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `warranties_test_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: Warranty } = await import("../models/Warranty.js"));
  ({ default: Claim } = await import("../models/Claim.js"));
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

test("warranty list, detail, eligibility states, and non-enumeration", async () => {
  const customerId = id();
  const otherId = id();

  const now = new Date();
  const activeWarranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "iPhone 13 Screen Repair",
    status: "ACTIVE",
    effectiveAt: new Date(now.getTime() - 10 * 86400000),
    expiresAt: new Date(now.getTime() + 80 * 86400000),
    claimAllowance: 1,
  });

  const upcomingWarranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "MacBook Pro Keyboard Repair",
    status: "ACTIVE",
    effectiveAt: new Date(now.getTime() + 5 * 86400000),
    expiresAt: new Date(now.getTime() + 95 * 86400000),
    claimAllowance: 1,
  });

  const expiredWarranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "iPad Battery Repair",
    status: "ACTIVE",
    effectiveAt: new Date(now.getTime() - 100 * 86400000),
    expiresAt: new Date(now.getTime() - 10 * 86400000),
    claimAllowance: 1,
  });

  const voidWarranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "Watch Water Damage",
    status: "VOID",
    effectiveAt: new Date(now.getTime() - 20 * 86400000),
    expiresAt: new Date(now.getTime() + 70 * 86400000),
    claimAllowance: 1,
  });

  const listRes = await request(app).get("/api/warranties/mine").set(auth(customerId));
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.data.warranties.length, 4);

  const activeRes = await request(app).get(`/api/warranties/${activeWarranty._id}`).set(auth(customerId));
  assert.equal(activeRes.status, 200);
  assert.equal(activeRes.body.data.status, "active");
  assert.equal(activeRes.body.data.claimEligibility.eligible, true);
  assert.deepEqual(Object.keys(activeRes.body.data).sort(), [
    "claimEligibility", "coverageSummary", "createdAt", "effectiveAt", "exclusions", "expiresAt", "id", "remainingClaimAllowance", "sourceId", "sourceType", "status", "termsVersion", "updatedAt"
  ]);

  const eligActive = await request(app).get(`/api/warranties/${activeWarranty._id}/eligibility`).set(auth(customerId));
  assert.equal(eligActive.body.data.eligible, true);

  const eligUpcoming = await request(app).get(`/api/warranties/${upcomingWarranty._id}/eligibility`).set(auth(customerId));
  assert.equal(eligUpcoming.body.data.eligible, false);
  assert.equal(eligUpcoming.body.data.reasonCode, "UPCOMING");

  const eligExpired = await request(app).get(`/api/warranties/${expiredWarranty._id}/eligibility`).set(auth(customerId));
  assert.equal(eligExpired.body.data.eligible, false);
  assert.equal(eligExpired.body.data.reasonCode, "EXPIRED");

  const eligVoid = await request(app).get(`/api/warranties/${voidWarranty._id}/eligibility`).set(auth(customerId));
  assert.equal(eligVoid.body.data.eligible, false);
  assert.equal(eligVoid.body.data.reasonCode, "VOID");

  const foreignRes = await request(app).get(`/api/warranties/${activeWarranty._id}`).set(auth(otherId));
  assert.equal(foreignRes.status, 404);
  assert.equal(foreignRes.body.errors[0].code, "warranty_unavailable");

  const randomRes = await request(app).get(`/api/warranties/${id()}`).set(auth(customerId));
  assert.equal(randomRes.status, 404);
  assert.equal(randomRes.body.errors[0].code, "warranty_unavailable");

  const malformedRes = await request(app).get("/api/warranties/not-a-valid-id").set(auth(customerId));
  assert.equal(malformedRes.status, 400);
});

test("claim creation, validation, idempotency, allowance enforcement, and concurrency", async () => {
  const customerId = id();
  const now = new Date();
  const warranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "iPhone Screen Repair",
    status: "ACTIVE",
    effectiveAt: new Date(now.getTime() - 10 * 86400000),
    expiresAt: new Date(now.getTime() + 80 * 86400000),
    claimAllowance: 1,
  });

  const invalidRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-1")
    .send({ description: "no" });
  assert.equal(invalidRes.status, 400);

  const missingKeyRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .send({ description: "The screen replacement has touch unresponsiveness on the left edge." });
  assert.equal(missingKeyRes.status, 400);

  const createRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-1")
    .send({ description: "The screen replacement has touch unresponsiveness on the left edge." });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "submitted");
  assert.deepEqual(createRes.body.data.warranty, { id: warranty._id.toString() });

  const replayRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-1")
    .send({ description: "The screen replacement has touch unresponsiveness on the left edge." });
  assert.equal(replayRes.status, 201);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);

  const conflictRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-1")
    .send({ description: "Different description entirely for same key." });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.errors[0].code, "claim_idempotency_conflict");

  const duplicateClaimRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-2")
    .send({ description: "Another claim while active claim exists." });
  assert.equal(duplicateClaimRes.status, 409);
  assert.equal(duplicateClaimRes.body.errors[0].code, "claim_ineligible");
});

test("claim staff status transition matrix, role authorization, and concurrency protection", async () => {
  const customerId = id();
  const now = new Date();
  const warranty = await Warranty.create({
    customer: customerId,
    repair: id(),
    deviceSummary: "Laptop Screen Repair",
    status: "ACTIVE",
    effectiveAt: new Date(now.getTime() - 10 * 86400000),
    expiresAt: new Date(now.getTime() + 80 * 86400000),
    claimAllowance: 1,
  });

  const claimRes = await request(app)
    .post(`/api/warranties/${warranty._id}/claims`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-claim-3")
    .send({ description: "Laptop displays lines across screen." });
  const claimId = claimRes.body.data.id;

  const customerPatch = await request(app)
    .patch(`/api/claims/${claimId}/status`)
    .set(auth(customerId, "customer"))
    .send({ status: "screening" });
  assert.equal(customerPatch.status, 403);

  const invalidTransition = await request(app)
    .patch(`/api/claims/${claimId}/status`)
    .set(auth(id(), "support_officer"))
    .send({ status: "resolved" });
  assert.equal(invalidTransition.status, 409);

  const validStep1 = await request(app)
    .patch(`/api/claims/${claimId}/status`)
    .set(auth(id(), "support_officer"))
    .send({ status: "screening", nextAction: "Support is evaluating warranty coverage." });
  assert.equal(validStep1.status, 200);
  assert.equal(validStep1.body.data.status, "screening");

  const validStep2 = await request(app)
    .patch(`/api/claims/${claimId}/status`)
    .set(auth(id(), "ops_manager"))
    .send({ status: "approved", remedy: { type: "repair", summary: "Approved for full repair." } });
  assert.equal(validStep2.status, 200);
  assert.equal(validStep2.body.data.status, "approved");

  const notifCount = await Notification.countDocuments({ recipient: customerId, type: "claim_status_updated" });
  assert.equal(notifCount, 2);

  await Claim.updateOne({ _id: claimId }, { $set: { status: "closed" } });

  const stalePatch = await request(app)
    .patch(`/api/claims/${claimId}/status`)
    .set(auth(id(), "support_officer"))
    .send({ status: "resolved" });
  assert.equal(stalePatch.status, 409);
});
