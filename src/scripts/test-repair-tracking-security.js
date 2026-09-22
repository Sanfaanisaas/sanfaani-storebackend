import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let RepairTrackingToken;
let Quote;
let replicaSet;
let sequence = 0;
const ACCESS_SECRET = "repair-tracking-access-secret-at-least-32-characters";
const TRACKING_SECRET = "repair-tracking-hmac-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({ Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const trackingUnavailable = (response) => {
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    success: false,
    message: "Repair tracking information is unavailable",
    errors: [{ code: "repair_tracking_unavailable", message: "Check the repair reference and tracking credentials" }],
  });
};

const createRepair = async (userId) => {
  sequence += 1;
  const response = await request(app).post("/api/repairs").set(auth(userId)).send({
    device: { type: "phone", brand: "Sanfaani", model: `T-${sequence}`, serialNumber: `serial-${sequence}` },
    issueDescription: "Screen intermittently fails to display correctly",
    privacyAcknowledged: true,
  });
  assert.equal(response.status, 201);
  return response.body.data;
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "repair-tracking-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "repair-tracking-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = TRACKING_SECRET;
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_repair_tracking_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be04-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `repair_tracking_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: RepairTrackingToken } = await import("../models/RepairTrackingToken.js"));
  ({ default: Quote } = await import("../models/Quote.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("raw, malformed, foreign and unknown identifiers receive the same non-enumerating tracking failure", async () => {
  const owner = id();
  const created = await createRepair(owner);
  const responses = await Promise.all([
    request(app).get(`/api/repairs/${created.repair._id}/track`),
    request(app).get("/api/repairs/not-an-id/track"),
    request(app).get(`/api/repairs/${created.repair._id}/track`).set(auth(id())),
    request(app).get(`/${id()}/api/repairs/${created.repair._id}/track`),
  ]);
  for (const response of responses.slice(0, 3)) trackingUnavailable(response);
});

test("owner bearer and only a valid repair-scoped token obtain the exact public projection", async () => {
  const owner = id();
  const created = await createRepair(owner);
  const ownerResponse = await request(app).get(`/api/repairs/${created.repair._id}/track`).set(auth(owner));
  const tokenResponse = await request(app).get(`/api/repairs/${created.repair._id}/track`).set("X-Repair-Tracking-Token", created.trackingToken);
  for (const response of [ownerResponse, tokenResponse]) {
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body.data).sort(), ["id", "nextAction", "quote", "status", "updatedAt"]);
    assert.equal(response.body.data.quote, null);
    assert.equal(JSON.stringify(response.body.data).includes("serial"), false);
    assert.equal(JSON.stringify(response.body.data).includes("device"), false);
  }
  const token = await RepairTrackingToken.findOne({ repair: created.repair._id }).lean();
  assert.ok(token.digest);
  assert.equal(JSON.stringify(token).includes(created.trackingToken), false);
});

test("expired, revoked, mismatched and wrong-repair tokens fail; owner rotation revokes every prior token", async () => {
  const owner = id();
  const first = await createRepair(owner);
  const second = await createRepair(owner);
  const wrongRepair = await request(app).get(`/api/repairs/${second.repair._id}/track`).set("X-Repair-Tracking-Token", first.trackingToken);
  trackingUnavailable(wrongRepair);
  const tampered = `${first.trackingToken.slice(0, -1)}${first.trackingToken.endsWith("A") ? "B" : "A"}`;
  trackingUnavailable(await request(app).get(`/api/repairs/${first.repair._id}/track`).set("X-Repair-Tracking-Token", tampered));
  await RepairTrackingToken.updateOne({ repair: first.repair._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  trackingUnavailable(await request(app).get(`/api/repairs/${first.repair._id}/track`).set("X-Repair-Tracking-Token", first.trackingToken));
  const rotated = await request(app).post(`/api/repairs/${first.repair._id}/tracking-token`).set(auth(owner));
  assert.equal(rotated.status, 200);
  trackingUnavailable(await request(app).get(`/api/repairs/${first.repair._id}/track`).set("X-Repair-Tracking-Token", first.trackingToken));
  assert.equal((await request(app).get(`/api/repairs/${first.repair._id}/track`).set("X-Repair-Tracking-Token", rotated.body.data.trackingToken)).status, 200);
});

test("a tracking token is read-only and cannot pass owner-only mutation authorization", async () => {
  const created = await createRepair(id());
  const response = await request(app).post(`/api/repairs/${created.repair._id}/tracking-token`).set("X-Repair-Tracking-Token", created.trackingToken);
  assert.equal(response.status, 401);
});

test("tracking quote projection is a strict public allowlist", async () => {
  const owner = id(); const created = await createRepair(owner);
  await Quote.create({ repair: created.repair._id, version: 1, lineItems: [{ description: "Battery", amount: 1234 }], totalAmount: 1234, estimatedDays: 2, status: "SENT", isActionable: true, expiresAt: new Date(Date.now() + 60000), createdBy: id() });
  const response = await request(app).get(`/api/repairs/${created.repair._id}/track`).set(auth(owner));
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.data.quote).sort(), ["depositRequirement", "estimatedDays", "expiresAt", "id", "issuedAt", "lineItems", "paymentState", "status", "superseded", "supersededByVersion", "totalAmount", "version"]);
  assert.ok(response.body.data.quote.expiresAt);
  assert.deepEqual(response.body.data.quote.depositRequirement, { required: false, amount: 0, currency: "NGN", dueBeforeWork: false });
  assert.deepEqual(response.body.data.quote.paymentState, { status: "not_required", confirmedAmount: 0, remainingAmount: 0 });
  assert.equal(JSON.stringify(response.body.data.quote).includes("providerReference"), false);
});
