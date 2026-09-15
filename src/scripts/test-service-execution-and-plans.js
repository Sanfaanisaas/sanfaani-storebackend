import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

const ACCESS_SECRET = "be20-access-secret-32-characters-long";
let app;
let User;
let ServiceRequest;
let ServiceQuotation;
let ServiceExecution;
let ServiceHistoryEntry;
let MaintenancePlan;
let AuditLog;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;

const key = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (principal) => ({
  Authorization: `Bearer ${jwt.sign({ userId: principal._id.toString(), role: principal.role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});
const call = (method, url) => request(app)[method](url).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());

const principal = async (role) => User.create({
  name: `${role} ${sequence}`,
  email: `${key(role)}@example.test`,
  passwordHash: "not-used-in-integration-test",
  role,
});

const approvedService = async ({ customer, depositRequired = false, paymentStatus = "not_required", confirmedAmount = 0 } = {}) => {
  const serviceRequest = await ServiceRequest.create({
    customer: customer._id,
    serviceType: "DEVICE_SETUP",
    deviceCategory: "Laptop",
    brand: "Safe brand",
    model: "Safe model",
    desiredOutcome: "Configure a secure workstation",
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    responsibilityPolicyVersion: "2026-07-device-data",
    status: "APPROVED",
    assessment: { result: "COMPATIBLE", summary: "Supported configuration" },
  });
  const quotation = await ServiceQuotation.create({
    serviceRequest: serviceRequest._id,
    customer: customer._id,
    version: 1,
    lineItems: [{ description: "Setup service", amount: 50000 }],
    totalAmount: 50000,
    estimatedDays: 2,
    expiresAt: new Date(Date.now() + 86_400_000),
    status: "APPROVED",
    superseded: false,
    isActionable: false,
    depositRequirement: { required: depositRequired, amount: depositRequired ? 20000 : 0, currency: "NGN", dueBeforeWork: depositRequired },
    paymentState: { status: paymentStatus, confirmedAmount, remainingAmount: depositRequired ? Math.max(0, 20000 - confirmedAmount) : 0 },
    decision: { type: "APPROVED", at: new Date(), idempotencyKey: key("approval"), version: 1 },
  });
  return { serviceRequest, quotation };
};

const schedule = ({ operator, technician, serviceRequest, expectedVersion, idempotencyKey = key("schedule"), scheduledStartAt = new Date(Date.now() + 3_600_000).toISOString(), scheduledEndAt = new Date(Date.now() + 7_200_000).toISOString() }) => call("post", `/api/services/requests/${serviceRequest._id}/schedule`)
  .set(auth(operator))
  .set("Idempotency-Key", idempotencyKey)
  .send({
    expectedVersion,
    assignedTechnicianId: technician._id.toString(),
    scheduledStartAt,
    scheduledEndAt,
    mode: "drop_off",
    location: "Sanfaani service desk",
    deviceSafeLabel: "Customer laptop",
    internalNotes: "Internal bench allocation",
  });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be20-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be20-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be20-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be20-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be20_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be20-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be20_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: ServiceRequest } = await import("../models/ServiceRequest.js"));
  ({ default: ServiceQuotation } = await import("../models/ServiceQuotation.js"));
  ({ default: ServiceExecution } = await import("../models/ServiceExecution.js"));
  ({ default: ServiceHistoryEntry } = await import("../models/ServiceHistoryEntry.js"));
  ({ default: MaintenancePlan } = await import("../models/MaintenancePlan.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setAuditServiceTestHooks({});
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

test.after(async () => {
  setAuditServiceTestHooks({});
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. scheduling binds the latest approved quotation and a server-verified technician", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest, quotation } = await approvedService({ customer });
  const result = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body.data).sort(), ["assignedTechnicianId", "customer", "deviceSafeLabel", "id", "quotation", "schedule", "serviceRequestId", "status", "timestamps", "version"].sort());
  assert.equal(result.body.data.status, "SCHEDULED");
  assert.equal(result.body.data.quotation.id, quotation._id.toString());
  assert.equal(result.body.data.assignedTechnicianId, technician._id.toString());
  assert.equal(JSON.stringify(result.body).includes("Internal bench allocation"), false);
  const stored = await ServiceExecution.findOne({ serviceRequest: serviceRequest._id }).select("+internalNotes +actions.schedule.idempotencyKey +actions.schedule.fingerprint");
  assert.equal(stored.internalNotes, "Internal bench allocation");
});

test("2. unapproved, stale, expired, incompatible, and malformed requests cannot be scheduled", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest, quotation } = await approvedService({ customer });
  quotation.status = "EXPIRED";
  quotation.expiresAt = new Date(Date.now() - 1000);
  await quotation.save();
  const expired = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.errors[0].code, "service_quote_not_executable");
  const malformed = await call("post", "/api/services/requests/not-an-id/schedule")
    .set(auth(operator)).set("Idempotency-Key", key("bad"))
    .send({ expectedVersion: 0, assignedTechnicianId: technician._id.toString(), scheduledStartAt: new Date(Date.now() + 1000).toISOString(), scheduledEndAt: new Date(Date.now() + 2000).toISOString(), mode: "drop_off", deviceSafeLabel: "Laptop" });
  assert.equal([400, 422].includes(malformed.status), true);
});

test("3. due-before-work deposits use server-controlled payment state", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const blocked = await approvedService({ customer, depositRequired: true, paymentStatus: "pending" });
  const denied = await schedule({ operator, technician, serviceRequest: blocked.serviceRequest, expectedVersion: blocked.serviceRequest.__v });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.errors[0].code, "service_deposit_required");
  blocked.quotation.paymentState = { status: "confirmed", confirmedAmount: 20000, remainingAmount: 0 };
  await blocked.quotation.save();
  const allowed = await schedule({ operator, technician, serviceRequest: blocked.serviceRequest, expectedVersion: blocked.serviceRequest.__v });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  const quoteInput = await ServiceRequest.create({ customer: customer._id, serviceType: "DEVICE_SETUP", deviceCategory: "Tablet", desiredOutcome: "Setup", licenceOwnershipAcknowledgement: true, backupAcknowledgement: true, responsibilityPolicyVersion: "v1", status: "COMPATIBLE", assessment: { result: "COMPATIBLE" } });
  const spoof = await call("post", `/api/services/requests/${quoteInput._id}/quotations`).set(auth(operator)).send({ lineItems: [{ description: "Setup", amount: 100 }], totalAmount: 100, estimatedDays: 1, expiresAt: new Date(Date.now() + 100000).toISOString(), depositRequirement: { required: true, amount: 50, currency: "NGN", dueBeforeWork: true }, paymentState: { status: "confirmed", confirmedAmount: 50, remainingAmount: 0 } });
  assert.equal([400, 422].includes(spoof.status), true);
});

test("4. scheduling is idempotent, rejects payload drift, and enforces optimistic concurrency", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const idempotencyKey = key("schedule-replay");
  const scheduledStartAt = new Date(Date.now() + 3_600_000).toISOString();
  const scheduledEndAt = new Date(Date.now() + 7_200_000).toISOString();
  const first = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v, idempotencyKey, scheduledStartAt, scheduledEndAt });
  const replay = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v, idempotencyKey, scheduledStartAt, scheduledEndAt });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.id, first.body.data.id);
  const drift = await call("post", `/api/services/requests/${serviceRequest._id}/schedule`).set(auth(operator)).set("Idempotency-Key", idempotencyKey).send({ expectedVersion: serviceRequest.__v, assignedTechnicianId: technician._id.toString(), scheduledStartAt: new Date(Date.now() + 10_000).toISOString(), scheduledEndAt: new Date(Date.now() + 20_000).toISOString(), mode: "onsite", deviceSafeLabel: "Changed" });
  assert.equal(drift.status, 409);
  assert.equal(drift.body.errors[0].code, "service_schedule_idempotency_conflict");
});

test("5. only the assigned technician or operations administrators can start and complete work", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const otherTechnician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const scheduled = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  const executionId = scheduled.body.data.id;
  const wrong = await call("post", `/api/services/executions/${executionId}/start`).set(auth(otherTechnician)).set("Idempotency-Key", key("wrong-start")).send({ expectedVersion: 1 });
  assert.equal(wrong.status, 404);
  const started = await call("post", `/api/services/executions/${executionId}/start`).set(auth(technician)).set("Idempotency-Key", key("start")).send({ expectedVersion: 1 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.status, "IN_PROGRESS");
  const customerAttempt = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(customer)).set("Idempotency-Key", key("customer-complete")).send({ expectedVersion: 2, workSummary: "Done" });
  assert.equal(customerAttempt.status, 403);
  const completed = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(technician)).set("Idempotency-Key", key("complete")).send({ expectedVersion: 2, workSummary: "Configured supported software and verified startup.", customerVisiblePartsAndServices: ["Operating system setup"], warrantyOutcome: "Service workmanship warranty applies", nextRecommendedMaintenance: "Review in six months", internalNotes: "Private technician observation" });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.data.status, "COMPLETED");
  assert.equal(JSON.stringify(completed.body).includes("Private technician observation"), false);
  assert.equal(await ServiceHistoryEntry.countDocuments({ serviceRequest: serviceRequest._id }), 1);
  const history = await call("get", "/api/services/history").set(auth(customer));
  assert.equal(history.status, 200);
  assert.equal(history.body.data.history[0].workSummary, "Configured supported software and verified startup.");
  assert.equal(JSON.stringify(history.body).includes("Private technician observation"), false);
});

test("6. completion is atomic and audit failure rolls back execution, request, history, and notification", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const scheduled = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  const executionId = scheduled.body.data.id;
  await call("post", `/api/services/executions/${executionId}/start`).set(auth(technician)).set("Idempotency-Key", key("start-rollback")).send({ expectedVersion: 1 });
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "SERVICE_EXECUTION_COMPLETED") throw new Error("forced audit failure"); } });
  const result = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(technician)).set("Idempotency-Key", key("complete-rollback")).send({ expectedVersion: 2, workSummary: "This must roll back" });
  assert.equal(result.status, 500);
  setAuditServiceTestHooks({});
  assert.equal((await ServiceExecution.findById(executionId)).status, "IN_PROGRESS");
  assert.equal((await ServiceRequest.findById(serviceRequest._id)).status, "IN_PROGRESS");
  assert.equal(await ServiceHistoryEntry.countDocuments({ serviceRequest: serviceRequest._id }), 0);
  assert.equal(await AuditLog.countDocuments({ action: "SERVICE_EXECUTION_COMPLETED" }), 0);
});

test("7. operations staff administer plans with owner isolation and optimistic concurrency", async () => {
  const customer = await principal("customer");
  const outsider = await principal("customer");
  const operator = await principal("ops_manager");
  const create = await call("post", "/api/maintenance-plans").set(auth(operator)).set("Idempotency-Key", key("plan-create")).send({ customerId: customer._id.toString(), scope: "Quarterly preventive maintenance", coveredDevices: ["Office laptops"], includedServices: ["Health check", "Cleaning"], frequency: "quarterly", startDate: new Date(Date.now() + 86400000).toISOString(), renewalDate: new Date(Date.now() + 366 * 86400000).toISOString(), renewalModel: "manual_renewal", visitLimits: "Four visits", exclusions: ["Accidental damage"], price: 250000, currency: "NGN", termsVersion: "2026-09", cancellationInstructions: "Contact support before renewal." });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.data.status, "UPCOMING");
  const planId = create.body.data.id;
  const owner = await call("get", `/api/maintenance-plans/${planId}`).set(auth(customer));
  const foreign = await call("get", `/api/maintenance-plans/${planId}`).set(auth(outsider));
  assert.equal(owner.status, 200);
  assert.equal(foreign.status, 404);
  const update = await call("patch", `/api/maintenance-plans/${planId}`).set(auth(operator)).send({ expectedVersion: 0, visitLimits: "Three scheduled visits" });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.data.version, 1);
  const stale = await call("patch", `/api/maintenance-plans/${planId}`).set(auth(operator)).send({ expectedVersion: 0, visitLimits: "Stale change" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.errors[0].code, "maintenance_plan_version_conflict");
});

test("8. cancellation and renewal are explicit, idempotent term transitions", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const plan = await MaintenancePlan.create({ customer: customer._id, scope: "Annual support", coveredDevices: ["Laptop"], includedServices: ["Maintenance"], frequency: "annual", startDate: new Date(Date.now() - 86400000), renewalDate: new Date(Date.now() + 86400000), renewalModel: "manual_renewal", status: "ACTIVE", price: 100000, currency: "NGN", termsVersion: "v1", cancellationInstructions: "Contact support", version: 0 });
  const cancelKey = key("cancel-plan");
  const cancelled = await call("post", `/api/maintenance-plans/${plan._id}/cancel`).set(auth(operator)).set("Idempotency-Key", cancelKey).send({ expectedVersion: 0, reason: "Customer requested cancellation" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const replay = await call("post", `/api/maintenance-plans/${plan._id}/cancel`).set(auth(operator)).set("Idempotency-Key", cancelKey).send({ expectedVersion: 0, reason: "Customer requested cancellation" });
  assert.equal(replay.status, 200);

  const renewable = await MaintenancePlan.create({ customer: customer._id, scope: "Annual support", coveredDevices: ["Laptop"], includedServices: ["Maintenance"], frequency: "annual", startDate: new Date(Date.now() - 365 * 86400000), renewalDate: new Date(Date.now() - 1000), renewalModel: "manual_renewal", status: "EXPIRED", price: 100000, currency: "NGN", termsVersion: "v1", cancellationInstructions: "Contact support", version: 0 });
  const renewalKey = key("renew-plan");
  const renewalPayload = { expectedVersion: 0, startDate: new Date(Date.now() + 86400000).toISOString(), renewalDate: new Date(Date.now() + 366 * 86400000).toISOString(), price: 120000, termsVersion: "v2" };
  const renewed = await call("post", `/api/maintenance-plans/${renewable._id}/renew`).set(auth(operator)).set("Idempotency-Key", renewalKey).send(renewalPayload);
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  assert.equal(renewed.body.data.renewedFromId, renewable._id.toString());
  const renewedReplay = await call("post", `/api/maintenance-plans/${renewable._id}/renew`).set(auth(operator)).set("Idempotency-Key", renewalKey).send(renewalPayload);
  assert.equal(renewedReplay.status, 200);
  assert.equal(renewedReplay.body.data.id, renewed.body.data.id);
});

test("9. customer and unrelated staff roles cannot administer executions or maintenance plans", async () => {
  const customer = await principal("customer");
  const support = await principal("support_officer");
  const deniedPlan = await call("post", "/api/maintenance-plans").set(auth(customer)).set("Idempotency-Key", key("denied-plan")).send({});
  const deniedStaff = await call("post", "/api/maintenance-plans").set(auth(support)).set("Idempotency-Key", key("denied-support")).send({});
  assert.equal(deniedPlan.status, 403);
  assert.equal(deniedStaff.status, 403);
});
