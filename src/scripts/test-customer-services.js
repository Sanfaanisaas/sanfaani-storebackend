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

const ACCESS_SECRET = "services-access-secret-32-characters-long";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "services-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "services-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "services-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "services-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_customer_services";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `services_test_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: ServiceRequest } = await import("../models/ServiceRequest.js"));
  ({ default: ServiceQuotation } = await import("../models/ServiceQuotation.js"));
  ({ default: MaintenancePlan } = await import("../models/MaintenancePlan.js"));
  ({ default: ServiceHistoryEntry } = await import("../models/ServiceHistoryEntry.js"));
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

test("service policy, request validation, credentials protection, idempotency, and non-enumeration", async () => {
  const customerId = id();

  const policyRes = await request(app).get("/api/services/policy").set(auth(customerId));
  assert.equal(policyRes.status, 200);
  assert.ok(policyRes.body.data.responsibilities.length > 0);

  const missingAckRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-bad1")
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      desiredOutcome: "RAM upgrade to 32GB",
      licenceOwnershipAcknowledgement: false,
      backupAcknowledgement: true,
    });
  assert.equal(missingAckRes.status, 400);

  const credentialNotesRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-bad2")
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      desiredOutcome: "RAM upgrade to 32GB",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
      notes: "The admin password is admin123",
    });
  assert.equal(credentialNotesRes.status, 400);

  const createRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-1")
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      brand: "Sanfaani",
      model: "ProBook X1",
      currentSpecifications: "16GB RAM, 512GB SSD",
      desiredOutcome: "Upgrade RAM to 32GB and SSD to 2TB",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
      fulfilmentPreference: "drop_off",
    });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "ASSESSMENT_REQUIRED");

  const replayRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-1")
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Laptop",
      brand: "Sanfaani",
      model: "ProBook X1",
      currentSpecifications: "16GB RAM, 512GB SSD",
      desiredOutcome: "Upgrade RAM to 32GB and SSD to 2TB",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
      fulfilmentPreference: "drop_off",
    });
  assert.equal(replayRes.status, 201);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);

  const requestId = createRes.body.data.id;
  const foreignRes = await request(app).get(`/api/services/requests/${requestId}`).set(auth(id()));
  assert.equal(foreignRes.status, 404);
  assert.equal(foreignRes.body.errors[0].code, "service_request_unavailable");
});

test("service staff assessment, quotation, customer decision, incompatible handling, and history/maintenance plans", async () => {
  const customerId = id();
  const staffId = id();

  const createReqRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-req2")
    .send({
      serviceType: "SOFTWARE_SETUP",
      deviceCategory: "Workstation",
      desiredOutcome: "Install specialized CAD software suite",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
    });
  const requestId = createReqRes.body.data.id;

  const assessmentRes = await request(app)
    .patch(`/api/services/requests/${requestId}/assessment`)
    .set(auth(staffId, "technician"))
    .send({
      result: "COMPATIBLE",
      summary: "Hardware meets CAD software minimum requirements.",
      nextAction: "Proceeding to issue service quotation.",
    });
  assert.equal(assessmentRes.status, 200);
  assert.equal(assessmentRes.body.data.assessment.result, "COMPATIBLE");

  const quoteRes = await request(app)
    .post(`/api/services/requests/${requestId}/quotations`)
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "CAD Suite Installation & Configuration", amount: 45000 }],
      totalAmount: 45000,
      estimatedDays: 1,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  assert.equal(quoteRes.status, 201);
  assert.equal(quoteRes.body.data.version, 1);
  const quoteId = quoteRes.body.data.id;

  const approveRes = await request(app)
    .post(`/api/services/quotations/${quoteId}/approve`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-approve-srv-1")
    .send({ version: 1 });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.data.status, "APPROVED");

  const incompReqRes = await request(app)
    .post("/api/services/requests")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-srv-incomp")
    .send({
      serviceType: "DEVICE_UPGRADE",
      deviceCategory: "Legacy PC",
      desiredOutcome: "Upgrade CPU to latest 14th gen",
      licenceOwnershipAcknowledgement: true,
      backupAcknowledgement: true,
    });
  const incompRequestId = incompReqRes.body.data.id;

  await request(app)
    .patch(`/api/services/requests/${incompRequestId}/assessment`)
    .set(auth(staffId, "technician"))
    .send({ result: "INCOMPATIBLE", summary: "Motherboard socket is incompatible with target CPU generation." });

  const incompQuoteRes = await request(app)
    .post(`/api/services/requests/${incompRequestId}/quotations`)
    .set(auth(staffId, "sales_advisor"))
    .send({
      lineItems: [{ description: "Attempted CPU Upgrade", amount: 20000 }],
      totalAmount: 20000,
      estimatedDays: 1,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  assert.equal(incompQuoteRes.status, 409);
  assert.equal(incompQuoteRes.body.errors[0].code, "service_incompatible");

  const plan = await MaintenancePlan.create({
    customer: customerId,
    scope: "Annual Office IT Maintenance",
    coveredDevices: ["5x Desktops", "1x Server"],
    includedServices: ["Quarterly Preventive Maintenance", "Priority Support"],
    frequency: "quarterly",
    startDate: new Date(),
    renewalModel: "manual_renewal",
    status: "ACTIVE",
    price: 200000,
    currency: "NGN",
    termsVersion: "2026-08-maint",
    cancellationInstructions: "Cancel via support ticket 30 days prior to renewal date.",
  });

  const planRes = await request(app).get(`/api/maintenance-plans/${plan._id}`).set(auth(customerId));
  assert.equal(planRes.status, 200);
  assert.equal(planRes.body.data.scope, "Annual Office IT Maintenance");

  const history = await ServiceHistoryEntry.create({
    customer: customerId,
    serviceRequest: new mongoose.Types.ObjectId(requestId),
    serviceReference: "SRV-2026-001",
    serviceType: "SOFTWARE_SETUP",
    deviceSafeLabel: "Workstation",
    performedAt: new Date(),
    status: "COMPLETED",
    workSummary: "Successfully installed and licensed CAD software package.",
  });

  const historyRes = await request(app).get(`/api/services/history/${history._id}`).set(auth(customerId));
  assert.equal(historyRes.status, 200);
  assert.equal(historyRes.body.data.serviceReference, "SRV-2026-001");

  const foreignPlanRes = await request(app).get(`/api/maintenance-plans/${plan._id}`).set(auth(id()));
  assert.equal(foreignPlanRes.status, 404);

  const foreignHistoryRes = await request(app).get(`/api/services/history/${history._id}`).set(auth(id()));
  assert.equal(foreignHistoryRes.status, 404);
});
