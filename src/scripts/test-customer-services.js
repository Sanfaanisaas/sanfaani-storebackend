import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let ServiceRequest;
let ServiceQuotation;
let MaintenancePlan;
let ServiceHistoryEntry;
let Notification;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "services-access-secret-32-chars-long";
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
  process.env.JWT_REFRESH_SECRET = "services-refresh-secret-32-chars-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "services-audit-secret-32-chars-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "services-tracking-secret-32-chars-long";
  process.env.GUIDANCE_TOKEN_SECRET = "services-guidance-secret-32-chars-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_customer_services";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be14-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `services_test_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: ServiceRequest } = await import("../models/ServiceRequest.js"));
  ({ default: ServiceQuotation } =
    await import("../models/ServiceQuotation.js").catch(() => ({
      default: mongoose.model(
        "ServiceQuotation",
        new mongoose.Schema({}, { strict: false }),
      ),
    })));
  ({ default: MaintenancePlan } =
    await import("../models/MaintenancePlan.js").catch(() => ({
      default: mongoose.model(
        "MaintenancePlan",
        new mongoose.Schema({}, { strict: false }),
      ),
    })));
  ({ default: ServiceHistoryEntry } =
    await import("../models/ServiceHistoryEntry.js").catch(() => ({
      default: mongoose.model(
        "ServiceHistoryEntry",
        new mongoose.Schema({}, { strict: false }),
      ),
    })));
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

test("1. Service validation blocks credentials, mandates acknowledgements, and enforces idempotency", async () => {
  const customerId = id();

  // Validate policy fetch
  const policyRes = await req("get", "/api/services/policy").set(
    auth(customerId),
  );
  assert.equal(policyRes.status, 200);
  assert.ok(policyRes.body.data.responsibilities.length > 0);

  // Prevent Missing Acknowledgements
  const missingAckRes = await req("post", "/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("srv-bad1"))
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      desiredOutcome: "RAM upgrade to 32GB",
      licenceOwnershipAcknowledgement: false,
      backupAcknowledgement: true,
    });
  assert.equal(
    [400, 422].includes(missingAckRes.status),
    true,
    "Should require backup acknowledgement",
  );

  // Prevent Credential Leakage in Notes
  const credentialNotesRes = await req("post", "/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("srv-bad2"))
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      desiredOutcome: "RAM upgrade to 32GB",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
      notes: "The admin password is admin123",
    });
  assert.equal(
    [400, 422].includes(credentialNotesRes.status),
    true,
    "Should reject passwords",
  );

  // Valid Request Creation -> 201
  const idempotencyKey = next("srv-1");
  const createPayload = {
    serviceType: "DEVICE_UPGRADE",
    deviceCategory: "Laptop",
    brand: "Sanfaani",
    model: "ProBook X1",
    currentSpecifications: "16GB RAM, 512GB SSD",
    desiredOutcome: "Upgrade RAM to 32GB and SSD to 2TB",
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    fulfilmentPreference: "drop_off",
  };

  const createRes = await req("post", "/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(createPayload);
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "ASSESSMENT_REQUIRED");

  // Exact Idempotent Replay -> 200/201
  const replayRes = await req("post", "/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(createPayload);
  assert.equal([200, 201].includes(replayRes.status), true);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);
});

test("2. Staff FSM strictly blocks Quotations for Incompatible services", async () => {
  const customerId = id();
  const staffId = id();

  const incompReqRes = await req("post", "/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", next("srv-incomp"))
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Legacy PC",
      desiredOutcome: "Upgrade CPU to latest 14th gen",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
    });
  const incompRequestId = incompReqRes.body.data.id;

  // Staff assesses as INCOMPATIBLE
  await req("patch", `/api/services/requests/${incompRequestId}/assessment`)
    .set(auth(staffId, "technician"))
    .send({
      result: "INCOMPATIBLE",
      summary: "Motherboard socket is incompatible with target CPU generation.",
    });

  // Staff tries to quote the incompatible request -> MUST fail (409)
  const incompQuoteRes = await req(
    "post",
    `/api/services/requests/${incompRequestId}/quotations`,
  )
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "Attempted CPU Upgrade", amount: 20000 }],
      totalAmount: 20000,
      estimatedDays: 1,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    });

  assert.equal(incompQuoteRes.status, 409);
  assert.equal(incompQuoteRes.body.errors[0].code, "service_incompatible");
});

test("3. Quotation FSM supersedes old quotes and Transaction DB locks protect decision race conditions", async () => {
  const customerId = id();
  const staffId = id();

  // Create Request & Assess (COMPATIBLE)
  const dbReq = await ServiceRequest.create({
    customer: customerId,
    serviceType: "SOFTWARE_SETUP",
    deviceCategory: "Workstation",
    desiredOutcome: "Install specialized CAD software suite",
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    responsibilityPolicyVersion: "v1",
    status: "COMPATIBLE",
    assessment: { result: "COMPATIBLE" },
  });

  // Issue V1 Quote
  const v1Res = await req(
    "post",
    `/api/services/requests/${dbReq._id}/quotations`,
  )
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "CAD Suite Setup", amount: 40000 }],
      totalAmount: 40000,
      estimatedDays: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
  assert.equal(v1Res.status, 201);
  const v1Id = v1Res.body.data.id;

  // Issue V2 Quote (supersedes V1)
  const v2Res = await req(
    "post",
    `/api/services/requests/${dbReq._id}/quotations`,
  )
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "Premium CAD Setup", amount: 45000 }],
      totalAmount: 45000,
      estimatedDays: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
  assert.equal(v2Res.status, 201);
  const v2Id = v2Res.body.data.id;

  // Customer tries to approve superseded V1 -> 409 Conflict
  const approveV1 = await req(
    "post",
    `/api/services/quotations/${v1Id}/approve`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", next("app-v1"))
    .send({ version: 1 });
  assert.equal(approveV1.status, 409);

  // RACE CONDITION: Customer clicks Approve and Decline at the exact same millisecond on V2
  const [resApprove, resDecline] = await Promise.all([
    req("post", `/api/services/quotations/${v2Id}/approve`)
      .set(auth(customerId))
      .set("Idempotency-Key", next("app2"))
      .send({ version: 2 }),
    req("post", `/api/services/quotations/${v2Id}/decline`)
      .set(auth(customerId))
      .set("Idempotency-Key", next("dec2"))
      .send({ version: 2 }),
  ]);

  // MongoDB session.withTransaction guarantees one wins (200) and one hits the OCC check (409)
  const statuses = [resApprove.status, resDecline.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  // Database must only have ONE outcome cleanly synced
  const finalQuote = await ServiceQuotation.findById(v2Id);
  const finalReq = await ServiceRequest.findById(dbReq._id);

  assert.equal(["APPROVED", "DECLINED"].includes(finalQuote.status), true);
  assert.equal(finalQuote.isActionable, false);
  assert.equal(["APPROVED", "DECLINED"].includes(finalReq.status), true);
});

test("4. Customer isolation securely shields Service Requests, History, and Maintenance Plans from foreign access", async () => {
  const customerId = id();
  const hackerId = id();

  const dbReq = await ServiceRequest.create({
    customer: customerId,
    serviceType: "DATA_MIGRATION",
    deviceCategory: "Tablet",
    desiredOutcome: "Copy",
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    responsibilityPolicyVersion: "v1",
  });

  const plan = await MaintenancePlan.create({
    customer: customerId,
    scope: "Annual IT Maintenance",
    coveredDevices: ["5x Desktops"],
    includedServices: ["Priority Support"],
    frequency: "quarterly",
    startDate: new Date(),
    renewalModel: "manual_renewal",
    status: "ACTIVE",
    price: 200000,
    currency: "NGN",
    termsVersion: "v1",
    cancellationInstructions: "Cancel via support",
  });

  const history = await ServiceHistoryEntry.create({
    customer: customerId,
    serviceRequest: dbReq._id,
    serviceReference: "SRV-2026-001",
    serviceType: "SOFTWARE_SETUP",
    deviceSafeLabel: "Workstation",
    performedAt: new Date(),
    status: "COMPLETED",
    workSummary: "Successfully installed.",
  });

  // Verify Owner Access
  const ownerPlanRes = await req(
    "get",
    `/api/maintenance-plans/${plan._id}`,
  ).set(auth(customerId));
  assert.equal(ownerPlanRes.status, 200);

  const ownerHistoryRes = await req(
    "get",
    `/api/services/history/${history._id}`,
  ).set(auth(customerId));
  assert.equal(ownerHistoryRes.status, 200);

  // Foreign accesses must yield non-enumerating 404s
  const reqRes = await req("get", `/api/services/requests/${dbReq._id}`).set(
    auth(hackerId),
  );
  const planRes = await req("get", `/api/maintenance-plans/${plan._id}`).set(
    auth(hackerId),
  );
  const historyRes = await req(
    "get",
    `/api/services/history/${history._id}`,
  ).set(auth(hackerId));

  assert.equal(reqRes.status, 404);
  assert.equal(planRes.status, 404);
  assert.equal(historyRes.status, 404);
  assert.equal(reqRes.body.errors[0].code.includes("unavailable"), true);
});
