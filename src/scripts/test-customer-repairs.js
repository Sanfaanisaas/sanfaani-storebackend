import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Repair;
let Order;
let Warranty;
let TrackingToken;
let ORDER_STATUS;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "repairs-access-secret-32-chars-long";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

// Helper for unauthenticated requests with just a tracking token
const trackReq = (url, token) =>
  request(app)
    .get(url)
    .set("X-Forwarded-For", id().toString())
    .set("X-Repair-Tracking-Token", token);
const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "repairs-refresh-secret-32-chars-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "repairs-audit-secret-32-chars-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "repairs-tracking-secret-32-chars-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_repairs_contract";
  // Deliberately clearing SENTRY_DSN to prevent its background worker from throwing unhandled async errors on teardown
  delete process.env.SENTRY_DSN;
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be15-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `repairs_test_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ ORDER_STATUS } = await import("../utils/constants.js"));

  // Safely grab the real models compiled by your app
  Warranty =
    mongoose.models.Warranty ||
    mongoose.model("Warranty", new mongoose.Schema({}, { strict: false }));
  TrackingToken =
    mongoose.models.TrackingToken ||
    mongoose.model("TrackingToken", new mongoose.Schema({}, { strict: false }));

  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  // Give floating background tasks (like emails or audit logs) 250ms to finish
  // before we aggressively pull the plug on the MongoDB instance.
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. Repair creation yields a secure cryptographic token, allowing unauthenticated read-only tracking and rotation", async () => {
  const customerId = id();

  const createRes = await req("post", "/api/repairs")
    .set(auth(customerId))
    .send({
      device: {
        type: "Laptop",
        brand: "Sanfaani",
        model: "ProBook X1",
        serialNumber: "SN-12345",
      },
      issueDescription: "Screen flickering constantly",
      privacyAcknowledged: true,
    });

  assert.equal(createRes.status, 201);
  const repairId = createRes.body.data.repair._id;
  const rawToken = createRes.body.data.trackingToken;
  assert.ok(rawToken, "Must return a one-time raw tracking token");

  const dbTokenDocs = await TrackingToken.find({ repair: repairId });
  assert.equal(
    JSON.stringify(dbTokenDocs).includes(rawToken),
    false,
    "Raw token leaked into DB!",
  );

  const trackRes = await trackReq(`/api/repairs/${repairId}/track`, rawToken);
  assert.equal(trackRes.status, 200);
  assert.equal(trackRes.body.data.id, repairId);

  const rotateRes = await req(
    "post",
    `/api/repairs/${repairId}/tracking-token`,
  ).set(auth(customerId));
  assert.equal(rotateRes.status, 200);
  const newToken = rotateRes.body.data.trackingToken;
  assert.notEqual(rawToken, newToken);

  const oldTrackRes = await trackReq(
    `/api/repairs/${repairId}/track`,
    rawToken,
  );
  assert.equal(oldTrackRes.status, 404);
});

test("2. Strict Role Fencing: Only the specifically assigned technician can record diagnosis or complete work", async () => {
  const customerId = id();
  const techA = id();
  const techB = id();
  const opsManager = id();

  const dbRepair = await Repair.create({
    customer: customerId,
    device: { type: "Phone", brand: "X", model: "Y" },
    issueDescription: "Broken screen",
    privacyAcknowledged: true,
    status: "RECEIVED",
  });

  const assignRes = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/assign-technician`,
  )
    .set(auth(opsManager, "ops_manager"))
    .send({ technicianId: techA });
  assert.equal(assignRes.status, 200);

  const techBDiagnosis = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/diagnosis`,
  )
    .set(auth(techB, "technician"))
    .send({ diagnosisNotes: "It's completely broken", estimatedCost: 50000 });
  assert.equal(techBDiagnosis.status, 403);
  assert.equal(
    techBDiagnosis.body.message.includes("not the assigned technician"),
    true,
  );

  const techADiagnosis = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/diagnosis`,
  )
    .set(auth(techA, "technician"))
    .send({ diagnosisNotes: "Needs new LCD", estimatedCost: 50000 });
  assert.equal(techADiagnosis.status, 200);
  assert.equal(techADiagnosis.body.data.status, "DIAGNOSING");
});

test("3. Quality Control (QC) strictly prevents self-approval and enforces evidence gates", async () => {
  const customerId = id();
  const techId = id();
  const qcId = id();

  const dbRepair = await Repair.create({
    customer: customerId,
    device: { type: "Tablet", brand: "X", model: "Y" },
    issueDescription: "Battery replacement",
    privacyAcknowledged: true,
    status: "IN_REPAIR",
    technician: techId,
  });

  const completeRes = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/complete`,
  )
    .set(auth(techId, "technician"))
    .send({ notes: "Installed new battery" });
  assert.equal(completeRes.status, 200);
  assert.equal(completeRes.body.data.status, "QC");

  const selfQcRes = await req("patch", `/api/repairs/${dbRepair._id}/qc`)
    .set(auth(techId, "qc_officer"))
    .send({
      passed: true,
      checklistVersion: "v1",
      results: { battery: "ok" },
      evidenceIds: [id()],
    });
  assert.equal(selfQcRes.status, 403);
  assert.equal(
    selfQcRes.body.message.includes("cannot QC their own work"),
    true,
  );

  const noEvidenceQcRes = await req("patch", `/api/repairs/${dbRepair._id}/qc`)
    .set(auth(qcId, "qc_officer"))
    .send({ passed: true });
  assert.equal(noEvidenceQcRes.status, 409);
  assert.equal(noEvidenceQcRes.body.errors[0].code, "qc_evidence_gate");

  const passQcRes = await req("patch", `/api/repairs/${dbRepair._id}/qc`)
    .set(auth(qcId, "qc_officer"))
    .send({
      passed: true,
      checklistVersion: "v1",
      results: { battery: "ok" },
      evidenceIds: [id()],
    });
  assert.equal(passQcRes.status, 200);
  assert.equal(passQcRes.body.data.status, "READY");
});

test("4. Handover FSM requires strict identity verification and auto-generates a Warranty", async () => {
  const customerId = id();
  const opsId = id();

  const dbRepair = await Repair.create({
    customer: customerId,
    device: { type: "Drone", brand: "X", model: "Y" },
    issueDescription: "Propeller fix",
    privacyAcknowledged: true,
    status: "READY",
    qcRecord: { passed: true },
  });

  const badHandoverRes = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/handover`,
  )
    .set(auth(opsId, "ops_manager"))
    .send({ recipient: "John Doe" });
  assert.equal(badHandoverRes.status, 409);
  assert.equal(
    badHandoverRes.body.errors[0].code,
    "repair_handover_evidence_gate",
  );

  const validHandoverRes = await req(
    "patch",
    `/api/repairs/${dbRepair._id}/handover`,
  )
    .set(auth(opsId, "ops_manager"))
    .send({
      recipient: "John Doe",
      identityVerificationMethod: "Drivers License",
      customerAcknowledgement: true,
    });
  assert.equal(validHandoverRes.status, 200);
  assert.equal(validHandoverRes.body.data.repair.status, "HANDED_OVER");

  const warrantyCount = await Warranty.countDocuments({ repair: dbRepair._id });
  assert.equal(warrantyCount, 1);
});

test("5. Order Payment & Dispatch FSM strictly transitions verified offline payments", async () => {
  const customerId = id();
  const productAdminId = id();

  const dbOrder = await Order.create({
    userId: customerId,
    items: [
      {
        productId: id(),
        variantSku: "SKU-1",
        nameSnapshot: "Laptop",
        priceSnapshot: 50000,
        quantity: 1,
      },
    ],
    subtotal: 50000,
    total: 50000,
    shippingAddress: { street: "1", city: "Lagos", state: "LA", country: "NG" },
    paymentMethod: "bank_transfer",
    paymentStatus: "pending",
    status: ORDER_STATUS.PENDING_PAYMENT,
  });

  const verifyRes = await req(
    "patch",
    `/api/orders/${dbOrder._id}/verify-bank-transfer`,
  ).set(auth(productAdminId, "product_admin"));
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.data.paymentStatus, "paid");
  assert.equal(verifyRes.body.data.status, ORDER_STATUS.PAID);

  const unauthorizedDispatch = await req(
    "patch",
    `/api/orders/${dbOrder._id}/dispatch`,
  ).set(auth(customerId));
  assert.equal(unauthorizedDispatch.status, 403);
});
