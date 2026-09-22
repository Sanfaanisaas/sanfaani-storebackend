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
let Payment;
let Refund;
let AuditLog;
let transitions;
let setPaystackProviderForTests;
let resetPaystackProviderForTests;
let replicaSet;
let sequence = 0;
const ACCESS_SECRET = "repair-finance-gates-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (userId, role) => ({ Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const clear = async () => { for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({}); };
const providerMetadata = (payment) => ({ subjectType: payment.subjectType, subjectId: payment.subjectId.toString(), owner: payment.owner.toString(), purpose: payment.purpose, quoteVersion: payment.quoteVersion });
const settlePayment = (payment) => request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("X-Paystack-Signature", "signed")
  .send({ event: "charge.success", data: { id: next("charge"), reference: payment.providerReference, amount: payment.amount, currency: payment.currency, paid_at: "2026-08-26T12:00:00.000Z", metadata: providerMetadata(payment) } });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "repair-finance-gates-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "repair-finance-gates-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "repair-finance-gates-tracking-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_repair_finance_gate_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be07-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `repair_gates_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: Payment } = await import("../models/Payment.js"));
  ({ default: Refund } = await import("../models/Refund.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  transitions = await import("../services/paymentTransitionService.js");
  ({ setPaystackProviderForTests, resetPaystackProviderForTests } = await import("../services/paystackProvider.js"));
  setPaystackProviderForTests({
    initializePayment: async (input) => ({ authorizationUrl: "https://fake-paystack.example/authorize", reference: input.reference }),
    verifyWebhookSignature: (_raw, signature) => signature === "signed",
    verifyTransaction: async () => { throw new Error("transition tests do not verify externally"); },
    requestRefund: async () => { throw new Error("no real refund request is allowed"); },
    verifyRefund: async () => { throw new Error("no real refund verification is allowed"); },
  });
  await mongoose.syncIndexes();
});
test.beforeEach(clear);
test.after(async () => { resetPaystackProviderForTests(); if (mongoose.connection.readyState) await mongoose.disconnect(); await replicaSet?.stop(); });

test("verified payment/refund records derive repair gates, and authorized overrides are auditable and revocable", async () => {
  const owner = id(); const technician = id(); const qcOfficer = id(); const finance = id(); const storeOperator = id(); const operations = id();
  const created = await request(app).post("/api/repairs").set(auth(owner, "customer")).send({ device: { type: "phone", brand: "Sanfaani", model: "Gate fixture" }, issueDescription: "The phone powers down during normal use", privacyAcknowledged: true });
  assert.equal(created.status, 201); const repairId = created.body.data.repair._id;
  const quote = await request(app).post(`/api/repairs/${repairId}/quote`).set(auth(technician, "technician")).send({ lineItems: [{ description: "Battery replacement", amount: 1000 }] });
  assert.equal(quote.status, 201);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/quote/${quote.body.data._id}/approve`).set(auth(owner, "customer"))).status, 200);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/assign-technician`).set(auth(operations, "ops_manager")).send({ technicianId: technician.toString() })).status, 200);
  await Repair.updateOne({ _id: repairId }, { $set: { "financial.requiredDepositAmount": 1000, "financial.depositCurrency": "NGN" } });

  assert.equal((await request(app).patch(`/api/repairs/${repairId}/start`).set(auth(technician, "technician"))).status, 409);
  const attempt = await request(app).post("/api/payments/attempts").set(auth(owner, "customer")).set("Idempotency-Key", "repair-gate-deposit").send({ subjectType: "repair", subjectId: repairId, purpose: "repair_deposit" });
  assert.equal(attempt.status, 200);
  const payment = await Payment.findById(attempt.body.data.paymentId);
  assert.equal((await settlePayment(payment)).status, 200);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/start`).set(auth(technician, "technician"))).status, 200);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/complete`).set(auth(technician, "technician")).send({ notes: "Work completed" })).status, 200);

  const reservation = await request(app).post(`/api/payments/${payment._id}/refunds`).set(auth(finance, "finance_officer")).set("Idempotency-Key", "repair-gate-refund").send({ amount: 1000, currency: "NGN", reason: "Repair service was cancelled" });
  assert.equal(reservation.status, 202);
  const refund = await Refund.findById(reservation.body.data._id);
  await transitions.settleRefundSuccess({ refundId: refund._id, providerEventId: "repair-gate-refund-success", providerReference: "repair-gate-refund-reference", normalized: { amount: refund.amount, currency: refund.currency, metadata: providerMetadata(payment) } });
  const afterRefund = await Repair.findById(repairId);
  assert.equal(afterRefund.financial.netPaidAmount, 0); assert.equal(afterRefund.financial.outstandingBalance, 1000); assert.equal(afterRefund.financial.financeGateState, "DEPOSIT_REQUIRED");

  const qcBody = { passed: true, checklistVersion: "v1", results: { battery: "passed" }, evidenceIds: [id().toString()] };
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/qc`).set(auth(qcOfficer, "qc_officer")).send(qcBody)).status, 409);
  const forbidden = await request(app).post(`/api/finance/repairs/${repairId}/overrides`).set(auth(owner, "customer")).send({ scope: "QC", reason: "Customer cannot override finance" });
  assert.equal(forbidden.status, 403);
  const qcOverride = await request(app).post(`/api/finance/repairs/${repairId}/overrides`).set(auth(finance, "finance_officer")).send({ scope: "QC", reason: "Finance-approved QC completion pending final settlement" });
  assert.equal(qcOverride.status, 201);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/qc`).set(auth(qcOfficer, "qc_officer")).send(qcBody)).status, 200);
  const handoverBody = { recipient: "Customer", identityVerificationMethod: "photo_id", customerAcknowledgement: true };
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/handover`).set(auth(storeOperator, "store_operator")).send(handoverBody)).status, 409);
  const allOverride = await request(app).post(`/api/finance/repairs/${repairId}/overrides`).set(auth(finance, "finance_officer")).send({ scope: "ALL", reason: "Finance-approved handover while settlement is investigated" });
  assert.equal(allOverride.status, 201);
  assert.equal((await request(app).patch(`/api/repairs/${repairId}/handover`).set(auth(storeOperator, "store_operator")).send(handoverBody)).status, 200);
  assert.equal(await AuditLog.countDocuments({ action: "REPAIR_FINANCE_OVERRIDE_CREATED" }), 2);
  const revoked = await request(app).post(`/api/finance/repair-finance-overrides/${allOverride.body.data._id}/revoke`).set(auth(finance, "finance_officer")).send({ reason: "Investigation closed" });
  assert.equal(revoked.status, 200); assert.equal(revoked.body.data.status, "REVOKED");
  assert.equal(await AuditLog.countDocuments({ action: "REPAIR_FINANCE_OVERRIDE_REVOKED" }), 1);
});
