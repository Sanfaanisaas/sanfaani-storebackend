import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Order;
let Repair;
let Payment;
let AuditLog;
let AppError;
let setPaystackProviderForTests;
let resetPaystackProviderForTests;
let replicaSet;
let sequence = 0;
let providerCalls;
const ACCESS_SECRET = "payment-attempt-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});
const clear = async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
};
const createOrder = async (owner, total = 12500) =>
  Order.create({
    userId: owner,
    items: [],
    shippingAddress: {
      street: "1 Payment Street",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
    subtotal: total,
    tax: 0,
    shippingCost: 0,
    total,
    status: "pending_payment",
    paymentMethod: "paystack",
    paymentStatus: "pending",
  });
const createRepair = async (owner, deposit = 4000) =>
  Repair.create({
    customer: owner,
    device: { type: "phone", brand: "Sanfaani", model: "Payment gate" },
    issueDescription: "The battery drains in ordinary use",
    privacyAcknowledged: true,
    status: "APPROVED",
    financial: {
      acceptedQuote: {
        quoteId: id(),
        version: 7,
        totalAmount: 12000,
        currency: "NGN",
        acceptedAt: new Date(),
      },
      acceptedQuoteTotal: 12000,
      requiredDepositAmount: deposit,
      depositCurrency: "NGN",
      confirmedPaidAmount: 0,
      refundedAmount: 0,
      netPaidAmount: 0,
      outstandingBalance: 12000,
    },
  });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET =
    "payment-attempt-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "payment-attempt-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "payment-attempt-tracking-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_payment_attempt_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be06-mongo");
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `payments_${process.pid}_${Date.now()}`,
  });
  ({ default: app } = await import("../app.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: Payment } = await import("../models/Payment.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: AppError } = await import("../utils/AppError.js"));
  ({ setPaystackProviderForTests, resetPaystackProviderForTests } =
    await import("../services/paystackProvider.js"));
  await mongoose.syncIndexes();
});
test.beforeEach(async () => {
  await clear();
  providerCalls = [];
  setPaystackProviderForTests({
    initializePayment: async (input) => {
      providerCalls.push(input);
      return {
        authorizationUrl: "https://fake-paystack.example/authorize",
        reference: input.reference,
      };
    },
    verifyWebhookSignature: (raw, signature) =>
      signature === "valid-test-signature" && Buffer.isBuffer(raw),
    verifyTransaction: async () => {
      throw new Error("the webhook path must not call provider verification");
    },
    requestRefund: async () => {
      throw new Error("the BE-06 test adapter must not request a real refund");
    },
    verifyRefund: async () => {
      throw new Error("the BE-06 test adapter must not verify a real refund");
    },
  });
});
test.after(async () => {
  resetPaystackProviderForTests();
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("payment attempt derives order bindings server-side and commits its audit", async () => {
  const owner = id();
  const order = await createOrder(owner, 12500);
  const response = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "order-attempt-1")
    .send({
      subjectType: "order",
      subjectId: order._id.toString(),
      email: "customer@example.test",
    });
  assert.equal(response.status, 200);
  const payment = await Payment.findById(response.body.data.paymentId).lean();
  assert.equal(payment.subjectType, "order");
  assert.equal(payment.subjectId.toString(), order._id.toString());
  assert.equal(payment.amount, 12500);
  assert.equal(payment.currency, "NGN");
  assert.equal(payment.purpose, "order_payment");
  assert.match(payment.providerReference, /^pst_[A-Za-z0-9_-]{32}$/);
  assert.match(payment.idempotencyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    await AuditLog.countDocuments({
      action: "PAYMENT_INITIATED",
      targetId: payment._id,
    }),
    1,
  );
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0].metadata, {
    subjectId: order._id.toString(),
    subjectType: "order",
    owner: owner.toString(),
    purpose: "order_payment",
    quoteVersion: null,
    paymentId: payment._id.toString(),
  });
});

test("identical payment idempotency replays and conflicting server-derived input returns 409", async () => {
  const owner = id();
  const order = await createOrder(owner, 12500);
  const first = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "same-attempt")
    .send({ subjectType: "order", subjectId: order._id.toString() });
  const replay = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "same-attempt")
    .send({ subjectType: "order", subjectId: order._id.toString() });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(first.body.data.paymentId, replay.body.data.paymentId);
  await Order.updateOne({ _id: order._id }, { $set: { total: 13000 } });
  const conflict = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "same-attempt")
    .send({ subjectType: "order", subjectId: order._id.toString() });
  assert.equal(conflict.status, 409);
  assert.equal(await Payment.countDocuments({ owner }), 1);
});

test("repair deposit attempts bind the accepted quote, owner, purpose, amount, and currency", async () => {
  const owner = id();
  const repair = await createRepair(owner, 4000);
  const response = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "repair-deposit-1")
    .send({
      subjectType: "repair",
      subjectId: repair._id.toString(),
      purpose: "repair_deposit",
    });
  assert.equal(response.status, 200);
  const payment = await Payment.findById(response.body.data.paymentId).lean();
  assert.equal(payment.owner.toString(), owner.toString());
  assert.equal(payment.quoteVersion, 7);
  assert.equal(payment.amount, 4000);
  assert.equal(payment.currency, "NGN");
  assert.equal(payment.purpose, "repair_deposit");

  const wrongPurpose = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "repair-bad-purpose")
    .send({
      subjectType: "repair",
      subjectId: repair._id.toString(),
      purpose: "order_payment",
    });
  // Accepts either Zod's 422 or the Controller's 400
  assert.equal(
    [400, 422].includes(wrongPurpose.status),
    true,
    `Expected 400 or 422, got ${wrongPurpose.status}`,
  );
});

test("invalid webhook signatures are rejected before transitions and provider failures use a controlled envelope", async () => {
  const owner = id();
  const order = await createOrder(owner);
  const created = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "webhook-signature")
    .send({ subjectType: "order", subjectId: order._id.toString() });
  const payment = await Payment.findById(created.body.data.paymentId);
  const webhook = await request(app)
    .post("/api/payments/webhook")
    .set("Content-Type", "application/json")
    .set("X-Paystack-Signature", "wrong-signature")
    .send({
      event: "charge.success",
      data: {
        id: next("event"),
        reference: payment.providerReference,
        amount: payment.amount,
        currency: payment.currency,
        metadata: {},
      },
    });
  assert.equal(webhook.status, 401);
  assert.equal((await Payment.findById(payment._id)).status, "PENDING");
  setPaystackProviderForTests({
    verifyWebhookSignature: () => true,
    verifyTransaction: async () => null,
    requestRefund: async () => null,
    verifyRefund: async () => null,
    initializePayment: async () => {
      throw new AppError("Payment provider is temporarily unavailable", 502, [
        {
          code: "payment_provider_unavailable",
          message: "Please try again later",
        },
      ]);
    },
  });
  const providerFailure = await request(app)
    .post("/api/payments/attempts")
    .set(auth(owner))
    .set("Idempotency-Key", "provider-failure")
    .send({ subjectType: "order", subjectId: order._id.toString() });
  assert.equal(providerFailure.status, 502);
  assert.equal(
    providerFailure.body.errors[0].code,
    "payment_provider_unavailable",
  );
  assert.equal(
    JSON.stringify(providerFailure.body).includes(
      process.env.PAYSTACK_SECRET_KEY,
    ),
    false,
  );
});
