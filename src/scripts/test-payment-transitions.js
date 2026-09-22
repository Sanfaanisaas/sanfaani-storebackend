import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Payment;
let Refund;
let Order;
let Repair;
let AuditLog;
let ReconciliationCase;
let transitions;
let setPaystackProviderForTests;
let resetPaystackProviderForTests;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;
let fakeProviderCalls = 0;

const ACCESS_SECRET = "payment-transitions-access-secret-at-least-32";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (userId, role = "finance_officer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});
const clear = async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
};
const paymentMetadata = (payment, extra = {}) => ({
  subjectType: payment.subjectType,
  subjectId: payment.subjectId.toString(),
  owner: payment.owner.toString(),
  purpose: payment.purpose,
  quoteVersion: payment.quoteVersion,
  ...extra,
});
const settlement = (payment, overrides = {}) => ({
  event: "charge.success",
  data: {
    id: overrides.eventId || next("charge"),
    reference: payment.providerReference,
    status: "success",
    amount: payment.amount,
    currency: payment.currency,
    paid_at: "2026-08-26T12:00:00.000Z",
    metadata: paymentMetadata(payment, overrides.metadata || {}),
    ...overrides.data,
  },
});
const webhook = (payload) =>
  request(app)
    .post("/api/payments/webhook")
    .set("X-Paystack-Signature", "fake-signature")
    .set("Content-Type", "application/json")
    .send(payload);

const seedOrderPayment = async ({
  amount = 10000,
  status = "PENDING",
} = {}) => {
  const owner = id();
  const order = await Order.create({
    userId: owner,
    items: [],
    shippingAddress: {
      street: "1 Test Street",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
    subtotal: amount,
    tax: 0,
    shippingCost: 0,
    total: amount,
    status: "pending_payment",
    paymentMethod: "paystack",
    paymentStatus: "pending",
  });
  const payment = await Payment.create({
    subjectType: "order",
    subjectId: order._id,
    owner,
    quoteVersion: null,
    provider: "paystack",
    providerReference: next("payref"),
    idempotencyKey: next("payment-key"),
    amount,
    capturedAmount: status === "PENDING" ? 0 : amount,
    refundedAmount: 0,
    reservedRefundAmount: 0,
    netPaidAmount: status === "PENDING" ? 0 : amount,
    currency: "NGN",
    purpose: "order_payment",
    status,
  });
  return { owner, order, payment };
};
const seedRepairPayment = async ({ amount = 5000, captured = 0 } = {}) => {
  const owner = id();
  const repair = await Repair.create({
    customer: owner,
    device: { type: "phone", brand: "Sanfaani", model: "Repair test" },
    issueDescription: "Battery drains in ordinary use",
    privacyAcknowledged: true,
    status: "APPROVED",
    financial: {
      acceptedQuote: {
        quoteId: id(),
        version: 1,
        totalAmount: 12000,
        currency: "NGN",
        acceptedAt: new Date(),
      },
      requiredDepositAmount: amount,
      depositCurrency: "NGN",
      confirmedPaidAmount: captured,
      refundedAmount: 0,
      netPaidAmount: captured,
      outstandingBalance: 12000 - captured,
      depositVerificationState: captured >= amount ? "VERIFIED" : "PENDING",
    },
  });
  const payment = await Payment.create({
    subjectType: "repair",
    subjectId: repair._id,
    owner,
    quoteVersion: 1,
    provider: "paystack",
    providerReference: next("repairref"),
    idempotencyKey: next("payment-key"),
    amount,
    capturedAmount: captured,
    refundedAmount: 0,
    reservedRefundAmount: 0,
    netPaidAmount: captured,
    currency: "NGN",
    purpose: "repair_deposit",
    status: captured ? "SUCCEEDED" : "PENDING",
  });
  return { owner, repair, payment };
};
const reserve = (
  payment,
  actor,
  amount,
  key = next("refund-key"),
  reason = "Operator approved the refund",
) =>
  transitions.reserveRefund({
    paymentId: payment._id,
    requestedBy: actor,
    amount,
    currency: payment.currency,
    reason,
    idempotencyKey: key,
  });
const providerData = (
  refund,
  providerReference = "refund-provider-reference",
) => ({
  providerReference,
  normalized: {
    amount: refund.amount,
    currency: refund.currency,
    metadata: {
      subjectType: refund.subjectType,
      subjectId: refund.subjectId.toString(),
      owner: refund.owner.toString(),
      purpose: refund.purpose,
    },
  },
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET =
    "payment-transitions-refresh-secret-at-least-32";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "payment-transitions-audit-secret-at-least-32";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "payment-transitions-tracking-secret-at-least-32";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_payment_transition_suite";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-phase-a-mongo");
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `payment_transitions_${process.pid}_${Date.now()}`,
  });
  ({ default: app } = await import("../app.js"));
  ({ default: Payment } = await import("../models/Payment.js"));
  ({ default: Refund } = await import("../models/Refund.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: ReconciliationCase } =
    await import("../models/ReconciliationCase.js"));
  transitions = await import("../services/paymentTransitionService.js");
  ({ setPaystackProviderForTests, resetPaystackProviderForTests } =
    await import("../services/paystackProvider.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  setPaystackProviderForTests({
    initializePayment: async () => {
      fakeProviderCalls += 1;
      return {
        authorizationUrl: "https://fake.example/pay",
        reference: "fake",
      };
    },
    verifyWebhookSignature: () => true,
    verifyTransaction: async () => {
      throw new Error("Fake provider must not be called by transitions");
    },
    requestRefund: async () => {
      throw new Error("A2 must not request provider refunds");
    },
    verifyRefund: async () => {
      throw new Error("A2 must not verify provider refunds");
    },
  });
  await mongoose.syncIndexes();
});
test.beforeEach(async () => {
  setAuditServiceTestHooks({});
  await clear();
});
test.after(async () => {
  setAuditServiceTestHooks({});
  resetPaystackProviderForTests();
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. Order payment settlement succeeds through the verified route", async () => {
  const { payment, order } = await seedOrderPayment();
  assert.equal((await webhook(settlement(payment))).status, 200);
  assert.equal((await Payment.findById(payment._id)).status, "SUCCEEDED");
  assert.equal((await Order.findById(order._id)).paymentStatus, "paid");
});
test("2. Repair-deposit settlement succeeds through the verified route", async () => {
  const { payment, repair } = await seedRepairPayment();
  assert.equal((await webhook(settlement(payment))).status, 200);
  const saved = await Repair.findById(repair._id);
  assert.equal(saved.financial.confirmedPaidAmount, payment.amount);
  assert.equal(saved.financial.netPaidAmount, payment.amount);
  assert.equal(saved.financial.depositVerificationState, "VERIFIED");
});
test("3. Duplicate payment event is idempotent", async () => {
  const { payment } = await seedOrderPayment();
  const event = settlement(payment, { eventId: "same-charge" });
  await webhook(event);
  await webhook(event);
  const saved = await Payment.findById(payment._id);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.capturedAmount, payment.amount);
});
test("4. Concurrent duplicate payment events do not double-count", async () => {
  const { payment, order } = await seedOrderPayment();
  const event = settlement(payment, { eventId: "concurrent-charge" });
  const results = await Promise.all([
    webhook(event),
    webhook(event),
    webhook(event),
  ]);
  results.forEach((result) => assert.equal(result.status, 200));
  assert.equal((await Payment.findById(payment._id)).events.length, 1);
  assert.equal((await Order.findById(order._id)).paymentStatus, "paid");
});
test("5. Terminal payment does not regress", async () => {
  const { payment } = await seedOrderPayment({ status: "FAILED" });
  await webhook(settlement(payment));
  assert.equal((await Payment.findById(payment._id)).status, "FAILED");
  assert.equal(
    await ReconciliationCase.countDocuments({
      category: "out_of_order_terminal_event",
    }),
    1,
  );
});
test("6. Settlement writes PAYMENT_SETTLED", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  assert.equal(
    await AuditLog.countDocuments({
      action: "PAYMENT_SETTLED",
      targetId: payment._id,
    }),
    1,
  );
});
test("7. Forced settlement-audit failure rolls back settlement", async () => {
  const { payment, order } = await seedOrderPayment();
  setAuditServiceTestHooks({
    beforeWrite: ({ action }) => {
      if (action === "PAYMENT_SETTLED") throw new Error("forced audit failure");
    },
  });
  assert.equal((await webhook(settlement(payment))).status, 500);
  assert.equal((await Payment.findById(payment._id)).status, "PENDING");
  assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
});
for (const [number, label, mutate, category] of [
  [
    8,
    "Amount",
    (event) => {
      event.data.amount += 1;
    },
    "amount_mismatch",
  ],
  [
    9,
    "Currency",
    (event) => {
      event.data.currency = "USD";
    },
    "currency_mismatch",
  ],
  [
    10,
    "Subject",
    (event) => {
      event.data.metadata.subjectId = id().toString();
    },
    "subject_mismatch",
  ],
  [
    11,
    "Owner",
    (event) => {
      event.data.metadata.owner = id().toString();
    },
    "owner_mismatch",
  ],
  [
    12,
    "Purpose",
    (event) => {
      event.data.metadata.purpose = "wrong";
    },
    "purpose_mismatch",
  ],
  [
    13,
    "Quote-version",
    (event) => {
      event.data.metadata.quoteVersion = 99;
    },
    "quote_version_mismatch",
  ],
])
  test(`${number}. ${label} mismatch prevents settlement and reconciles`, async () => {
    const fixture =
      category === "quote_version_mismatch"
        ? await seedRepairPayment()
        : await seedOrderPayment();
    const event = settlement(fixture.payment);
    mutate(event);
    await webhook(event);
    assert.equal(
      (await Payment.findById(fixture.payment._id)).status,
      "PENDING",
    );
    assert.equal(await ReconciliationCase.countDocuments({ category }), 1);
  });
test("14. Replayed mismatch reuses the reconciliation case", async () => {
  const { payment } = await seedOrderPayment();
  const event = settlement(payment, { eventId: "mismatch-replay" });
  event.data.amount += 1;
  await webhook(event);
  await webhook(event);
  const record = await ReconciliationCase.findOne({
    category: "amount_mismatch",
  });
  assert.equal(
    await ReconciliationCase.countDocuments({ category: "amount_mismatch" }),
    1,
  );
  assert.equal(record.occurrenceCount, 2);
});
test("15. Refund reservation succeeds through the finance-only route", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const actor = id();
  const response = await request(app)
    .post(`/api/payments/${payment._id}/refunds`)
    .set(auth(actor))
    .set("Idempotency-Key", "reserve-route")
    .send({
      amount: 2500,
      currency: "NGN",
      reason: "Customer return approved",
    });
  assert.equal(response.status, 202);
  assert.equal(response.body.data.status, "RESERVED");
  assert.equal(
    (await Payment.findById(payment._id)).reservedRefundAmount,
    2500,
  );
});
test("16. Raw client subject and owner metadata cannot override persisted bindings", async () => {
  const { payment, owner } = await seedOrderPayment();
  await webhook(settlement(payment));
  const response = await request(app)
    .post(`/api/payments/${payment._id}/refunds`)
    .set(auth(id()))
    .set("Idempotency-Key", "bad-client-fields")
    .send({
      amount: 10,
      currency: "NGN",
      reason: "Valid reason",
      subjectId: id().toString(),
      owner: owner.toString(),
    });
  assert.equal(
    [400, 422].includes(response.status),
    true,
    `Expected validation error, got ${response.status}`,
  );
  assert.equal(await Refund.countDocuments(), 0);
});
test("17. Zero refund amount fails", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  await assert.rejects(
    () => reserve(payment, id(), 0),
    (error) => error.statusCode === 400,
  );
});
test("18. Negative refund amount fails", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  await assert.rejects(
    () => reserve(payment, id(), -1),
    (error) => error.statusCode === 400,
  );
});
test("19. Excessive refund amount fails", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  await assert.rejects(
    () => reserve(payment, id(), payment.amount + 1),
    (error) => error.statusCode === 409,
  );
});
test("20. Currency-mismatched refund fails", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  await assert.rejects(
    () =>
      transitions.reserveRefund({
        paymentId: payment._id,
        requestedBy: id(),
        amount: 10,
        currency: "USD",
        reason: "Valid operator reason",
        idempotencyKey: next("key"),
      }),
    (error) => error.statusCode === 409,
  );
});
test("21. Identical idempotency retry returns the same refund", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const actor = id();
  const key = "same-refund-key";
  const first = await reserve(payment, actor, 1000, key);
  const second = await reserve(payment, actor, 1000, key);
  assert.equal(first.refund._id.toString(), second.refund._id.toString());
  assert.equal(second.replayed, true);
  assert.equal(
    (await Payment.findById(payment._id)).reservedRefundAmount,
    1000,
  );
});
test("22. Conflicting idempotency reuse returns 409", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const actor = id();
  await reserve(payment, actor, 1000, "conflict-key");
  await assert.rejects(
    () => reserve(payment, actor, 1200, "conflict-key"),
    (error) => error.statusCode === 409,
  );
});
test("23. Concurrent reservations cannot exceed captured funds", async () => {
  const { payment } = await seedOrderPayment({ amount: 100 });
  await webhook(settlement(payment));
  const attempts = await Promise.allSettled([
    reserve(payment, id(), 70),
    reserve(payment, id(), 70),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await Payment.findById(payment._id)).reservedRefundAmount, 70);
});
test("24. Provider-pending retains the reservation", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  await transitions.markRefundProviderPending({
    refundId: refund._id,
    providerEventId: "refund-pending",
    ...providerData(refund),
  });
  assert.equal((await Refund.findById(refund._id)).status, "PROVIDER_PENDING");
  assert.equal(
    (await Payment.findById(payment._id)).reservedRefundAmount,
    1000,
  );
});
test("verified refund provider callbacks settle through the webhook boundary", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  const response = await request(app)
    .post("/api/payments/webhook")
    .set("X-Paystack-Signature", "fake-signature")
    .set("Content-Type", "application/json")
    .send({
      event: "refund.processed",
      data: {
        id: "verified-refund-webhook",
        reference: "verified-refund-provider-reference",
        amount: refund.amount,
        currency: refund.currency,
        metadata: {
          ...paymentMetadata(payment),
          refundId: refund._id.toString(),
        },
      },
    });
  assert.equal(response.status, 200);
  assert.equal((await Refund.findById(refund._id)).status, "SUCCEEDED");
  assert.equal((await Payment.findById(payment._id)).refundedAmount, 1000);
});
test("25. Partial refund succeeds and updates repair finance once", async () => {
  const { payment, repair } = await seedRepairPayment({ captured: 5000 });
  const { refund } = await reserve(payment, id(), 2000);
  await transitions.settleRefundSuccess({
    refundId: refund._id,
    providerEventId: "repair-success",
    ...providerData(refund),
  });
  await transitions.settleRefundSuccess({
    refundId: refund._id,
    providerEventId: "repair-success",
    ...providerData(refund),
  });
  const savedPayment = await Payment.findById(payment._id);
  const savedRepair = await Repair.findById(repair._id);
  assert.equal(savedPayment.refundedAmount, 2000);
  assert.equal(savedPayment.netPaidAmount, 3000);
  assert.equal(savedRepair.financial.refundedAmount, 2000);
  assert.equal(savedRepair.financial.netPaidAmount, 3000);
});
test("26. Full refund produces the canonical fully-refunded state", async () => {
  const { payment, order } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), payment.amount);
  await transitions.settleRefundSuccess({
    refundId: refund._id,
    providerEventId: "full-success",
    ...providerData(refund),
  });
  assert.equal((await Payment.findById(payment._id)).status, "REFUNDED");
  const saved = await Order.findById(order._id);
  assert.equal(saved.paymentStatus, "refunded");
  assert.equal(saved.status, "refunded");
});
test("27. Duplicate refund success does not double-refund", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  const input = {
    refundId: refund._id,
    providerEventId: "duplicate-success",
    ...providerData(refund),
  };
  await transitions.settleRefundSuccess(input);
  await transitions.settleRefundSuccess(input);
  const saved = await Payment.findById(payment._id);
  assert.equal(saved.refundedAmount, 1000);
  assert.equal(saved.reservedRefundAmount, 0);
});
test("28. Failed refund releases its reservation", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  await transitions.settleRefundFailure({
    refundId: refund._id,
    providerEventId: "failed-refund",
    failureCategory: "provider_declined",
    ...providerData(refund),
  });
  assert.equal((await Refund.findById(refund._id)).status, "FAILED");
  assert.equal((await Payment.findById(payment._id)).reservedRefundAmount, 0);
});
test("29. Cancelled reservation releases its reservation", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const actor = id();
  const { refund } = await reserve(payment, actor, 1000);
  await transitions.cancelReservedRefund({
    refundId: refund._id,
    cancelledBy: actor,
  });
  assert.equal((await Refund.findById(refund._id)).status, "CANCELLED");
  assert.equal((await Payment.findById(payment._id)).reservedRefundAmount, 0);
});
test("30. Contradictory late provider result reconciles without regression", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  await transitions.cancelReservedRefund({
    refundId: refund._id,
    cancelledBy: id(),
  });
  await transitions.settleRefundSuccess({
    refundId: refund._id,
    providerEventId: "late-success",
    ...providerData(refund),
  });
  assert.equal((await Refund.findById(refund._id)).status, "CANCELLED");
  assert.equal(
    await ReconciliationCase.countDocuments({
      category: "out_of_order_terminal_event",
    }),
    1,
  );
});
test("31. Refund success and audit roll back together on forced audit failure", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const { refund } = await reserve(payment, id(), 1000);
  setAuditServiceTestHooks({
    beforeWrite: ({ action }) => {
      if (action === "REFUND_SUCCEEDED")
        throw new Error("forced refund audit failure");
    },
  });
  await assert.rejects(() =>
    transitions.settleRefundSuccess({
      refundId: refund._id,
      providerEventId: "audit-fail",
      ...providerData(refund),
    }),
  );
  assert.equal((await Refund.findById(refund._id)).status, "RESERVED");
  const saved = await Payment.findById(payment._id);
  assert.equal(saved.refundedAmount, 0);
  assert.equal(saved.reservedRefundAmount, 1000);
});
test("32. Unauthorized role receives 403 and no refund is created", async () => {
  const { payment } = await seedOrderPayment();
  await webhook(settlement(payment));
  const response = await request(app)
    .post(`/api/payments/${payment._id}/refunds`)
    .set(auth(id(), "customer"))
    .set("Idempotency-Key", "forbidden-refund")
    .send({
      amount: 1000,
      currency: "NGN",
      reason: "Customer cannot initiate this",
    });
  assert.equal(response.status, 403);
  assert.equal(await Refund.countDocuments(), 0);
});

test("A2 privacy and persistence controls remain enforced", async () => {
  const { payment } = await seedOrderPayment();
  const rawMarker = "UNCONTROLLED_RAW_PROVIDER_BODY";
  await webhook(
    settlement(payment, {
      eventId: "privacy-event",
      data: {
        metadata: { ...paymentMetadata(payment), uncontrolled: rawMarker },
      },
    }),
  );
  const saved = await Payment.findById(payment._id).lean();
  const indexes = await ReconciliationCase.collection.indexes();
  const refundIndexes = await Refund.collection.indexes();
  assert.equal(JSON.stringify(saved).includes(rawMarker), false);
  assert.equal(
    JSON.stringify(saved).includes(process.env.PAYSTACK_SECRET_KEY),
    false,
  );
  assert.ok(
    indexes.some(
      (index) => index.name === "unique_reconciliation_deduplication_key",
    ),
  );
  assert.ok(
    refundIndexes.some(
      (index) => index.name === "unique_refund_idempotency_per_actor_payment",
    ),
  );
  assert.equal(fakeProviderCalls, 0);
  assert.match(process.env.MONGO_URI, /127\.0\.0\.1|localhost/);
  await transitions.settleRefundSuccess({
    refundId: id(),
    providerEventId: "unknown-refund",
    providerReference: "unknown-ref",
    normalized: { amount: 1, currency: "NGN" },
  });
  assert.equal(
    await ReconciliationCase.countDocuments({
      category: "unknown_refund_reference",
    }),
    1,
  );
  const amounts = await Payment.find().lean();
  amounts.forEach((entry) => {
    assert.ok(
      entry.capturedAmount >= 0 &&
        entry.refundedAmount >= 0 &&
        entry.reservedRefundAmount >= 0 &&
        entry.netPaidAmount >= 0,
    );
  });
});
