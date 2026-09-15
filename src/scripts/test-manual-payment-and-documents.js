import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let AuditLog;
let Evidence;
let FinancialDocument;
let Order;
let Payment;
let StockReservation;
let memoryEvidenceStorageAdapter;
let setEvidenceStorageAdapter;
let setAuditServiceTestHooks;
let replicaSet;
let storage;
let sequence = 0;

const ACCESS_SECRET = "be17-access-secret-that-is-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: userId.toString(), role, type: "access" },
    ACCESS_SECRET,
    { algorithm: "HS256", expiresIn: "15m" },
  )}`,
});
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const clear = async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
};
const createOrder = async (owner, overrides = {}) => Order.create({
  userId: owner,
  items: [{
    productId: id(),
    variantSku: `BE17-SKU-${++sequence}`,
    nameSnapshot: "Verified handset",
    priceSnapshot: 40_000,
    quantity: 1,
  }],
  shippingAddress: {
    street: "17 Finance Street",
    city: "Ibadan Central",
    state: "Oyo",
    country: "Nigeria",
  },
  subtotal: 40_000,
  tax: 0,
  shippingCost: 0,
  total: 40_000,
  paymentMethod: "bank_transfer",
  paymentStatus: "pending",
  status: "pending_payment",
  ...overrides,
});
const uploadProof = (owner, orderId) => request(app)
  .post(`/api/orders/${orderId}/upload-receipt`)
  .set(auth(owner))
  .attach("receipt", jpeg, { filename: "bank-proof.jpg", contentType: "image/jpeg" });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be17-refresh-secret-that-is-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be17-audit-secret-that-is-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be17-tracking-secret-that-is-at-least-32-characters";
  process.env.GUIDANCE_TOKEN_SECRET = "be17-guidance-secret-that-is-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be17";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be17-mongo");
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger", args: ["--nounixsocket"] },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be17_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ default: FinancialDocument } = await import("../models/FinancialDocument.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Payment } = await import("../models/Payment.js"));
  ({ default: StockReservation } = await import("../models/StockReservation.js"));
  ({ memoryEvidenceStorageAdapter, setEvidenceStorageAdapter } = await import("../services/evidenceStorageService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  await clear();
  storage = memoryEvidenceStorageAdapter();
  setEvidenceStorageAdapter(storage);
  setAuditServiceTestHooks();
});

test.after(async () => {
  setAuditServiceTestHooks?.();
  setEvidenceStorageAdapter?.(null);
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. an owner uploads bank proof into private Evidence storage", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await uploadProof(owner, order._id);
  assert.equal(response.status, 201);
  assert.equal(response.body.data.evidence.purpose, "order_receipt");
  assert.equal("objectKey" in response.body.data.evidence, false);
  assert.equal(storage.objectCount(), 1);
  assert.equal(await Evidence.countDocuments({ subject: order._id }), 1);
});

test("2. upload derives canonical payment bindings from the persisted order", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  const payment = await Payment.findOne({ subjectId: order._id });
  assert.equal(payment.owner.toString(), owner.toString());
  assert.equal(payment.amount, 40_000);
  assert.equal(payment.currency, "NGN");
  assert.equal(payment.purpose, "order_payment");
  assert.equal(payment.provider, "bank_transfer");
  assert.ok(payment.evidence);
});

test("3. foreign and random order references use the same unavailable response", async () => {
  const owner = id(); const foreign = id(); const order = await createOrder(owner);
  const foreignResponse = await uploadProof(foreign, order._id);
  const randomResponse = await uploadProof(foreign, id());
  assert.equal(foreignResponse.status, 404);
  assert.equal(randomResponse.status, 404);
  assert.deepEqual(foreignResponse.body, randomResponse.body);
  assert.equal(storage.objectCount(), 0);
});

test("4. malformed identifiers fail without persisting proof", async () => {
  const response = await uploadProof(id(), "not-an-object-id");
  assert.equal(response.status, 404);
  assert.equal(storage.objectCount(), 0);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("5. proof cannot change a server-selected payment method", async () => {
  const owner = id(); const order = await createOrder(owner, { paymentMethod: "paystack" });
  const response = await uploadProof(owner, order._id);
  assert.equal(response.status, 404);
  assert.equal((await Order.findById(order._id)).paymentMethod, "paystack");
});

test("6. failed transactional persistence compensates the private object", async () => {
  const owner = id(); const order = await createOrder(owner);
  setAuditServiceTestHooks({ beforeWrite: async () => { throw new Error("forced-audit-failure"); } });
  const response = await uploadProof(owner, order._id);
  assert.equal(response.status, 500);
  assert.equal(storage.objectCount(), 0);
  assert.equal(await Evidence.countDocuments(), 0);
  assert.equal(await Payment.countDocuments(), 0);
});

test("7. customer and unrelated admin roles cannot verify a transfer", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  for (const role of ["customer", "product_admin", "store_operator"]) {
    const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), role));
    assert.equal(response.status, 403);
  }
  assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
});

test("8. finance, operations, and super-admin roles may verify", async () => {
  for (const role of ["finance_officer", "ops_manager", "super_admin"]) {
    const owner = id(); const order = await createOrder(owner);
    await uploadProof(owner, order._id);
    const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), role));
    assert.equal(response.status, 200, `${role}: ${JSON.stringify(response.body)}`);
  }
});

test("9. verification atomically settles Payment, Order, allocation, audit, and documents", async () => {
  const owner = id(); const actor = id(); const order = await createOrder(owner);
  await StockReservation.create({ order: order._id, product: order.items[0].productId, variant: id(), quantity: 1, status: "RESERVED", expiresAt: new Date(Date.now() + 60_000) });
  await uploadProof(owner, order._id);
  const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(actor, "finance_officer"));
  assert.equal(response.status, 200);
  const storedOrder = await Order.findById(order._id);
  const payment = await Payment.findOne({ subjectId: order._id });
  const reservation = await StockReservation.findOne({ order: order._id });
  assert.equal(storedOrder.paymentStatus, "paid");
  assert.equal(payment.status, "SUCCEEDED");
  assert.equal(payment.netPaidAmount, order.total);
  assert.equal(payment.verifiedBy.toString(), actor.toString());
  assert.equal(reservation.status, "ALLOCATED");
  assert.equal(await FinancialDocument.countDocuments({ order: order._id }), 2);
  assert.equal(await AuditLog.countDocuments({ action: "BANK_TRANSFER_VERIFIED" }), 1);
});

test("10. an order without active proof cannot be verified", async () => {
  const order = await createOrder(id());
  const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "finance_officer"));
  assert.equal(response.status, 404);
  assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
});

test("11. repeated verification is idempotent", async () => {
  const owner = id(); const order = await createOrder(owner); const actor = id();
  await uploadProof(owner, order._id);
  const first = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(actor, "finance_officer"));
  const second = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(actor, "finance_officer"));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(await AuditLog.countDocuments({ action: "BANK_TRANSFER_VERIFIED" }), 1);
  assert.equal(await FinancialDocument.countDocuments({ order: order._id }), 2);
});

test("12. pickup eligibility uses persisted amount, address, method, and expiry", async () => {
  const owner = id();
  const order = await createOrder(owner, { paymentMethod: "pay_on_pickup", payOnPickupExpiresAt: new Date(Date.now() + 60_000) });
  const eligible = await request(app).get(`/api/orders/${order._id}/eligible-pickup?total=1&shippingAddress={}`).set(auth(owner));
  assert.equal(eligible.status, 200);
  assert.equal(eligible.body.data.eligible, true);
  order.total = 80_000;
  await order.save();
  const ineligible = await request(app).get(`/api/orders/${order._id}/eligible-pickup`).set(auth(owner));
  assert.equal(ineligible.body.data.eligible, false);
});

test("13. expired pickup eligibility fails and foreign orders are non-enumerating", async () => {
  const owner = id();
  const order = await createOrder(owner, { paymentMethod: "pay_on_pickup", payOnPickupExpiresAt: new Date(Date.now() - 1) });
  const expired = await request(app).get(`/api/orders/${order._id}/eligible-pickup`).set(auth(owner));
  const foreign = await request(app).get(`/api/orders/${order._id}/eligible-pickup`).set(auth(id()));
  const random = await request(app).get(`/api/orders/${id()}/eligible-pickup`).set(auth(id()));
  assert.equal(expired.body.data.eligible, false);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, random.body);
});

test("14. a receipt exists only for a canonically verified payment", async () => {
  const owner = id(); const order = await createOrder(owner);
  const before = await request(app).get(`/api/orders/${order._id}/receipt`).set(auth(owner));
  assert.equal(before.status, 404);
  await uploadProof(owner, order._id);
  await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "finance_officer"));
  const after = await request(app).get(`/api/orders/${order._id}/receipt`).set(auth(owner));
  assert.equal(after.status, 200);
  assert.match(after.headers["content-type"], /application\/pdf/);
});

test("15. document snapshots remain unchanged when the order later mutates", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "finance_officer"));
  const before = await FinancialDocument.find({ order: order._id }).sort({ kind: 1 }).lean();
  await Order.updateOne({ _id: order._id }, { $set: { total: 99_999, "items.0.nameSnapshot": "Mutated" } });
  await request(app).get(`/api/orders/${order._id}/invoice`).set(auth(owner));
  await request(app).get(`/api/orders/${order._id}/receipt`).set(auth(owner));
  const after = await FinancialDocument.find({ order: order._id }).sort({ kind: 1 }).lean();
  assert.deepEqual(after, before);
  assert.equal(after[0].snapshot.total, 40_000);
});

test("16. financial documents reject updates and deletion", async () => {
  const owner = id(); const order = await createOrder(owner);
  await request(app).get(`/api/orders/${order._id}/invoice`).set(auth(owner));
  const document = await FinancialDocument.findOne({ order: order._id });
  await assert.rejects(FinancialDocument.updateOne({ _id: document._id }, { $set: { "snapshot.total": 1 } }), /immutable/);
  await assert.rejects(FinancialDocument.deleteOne({ _id: document._id }), /immutable/);
});

test("17. document access is owner-scoped and non-enumerating", async () => {
  const owner = id(); const order = await createOrder(owner);
  const foreign = await request(app).get(`/api/orders/${order._id}/invoice`).set(auth(id()));
  const random = await request(app).get(`/api/orders/${id()}/invoice`).set(auth(id()));
  const malformed = await request(app).get("/api/orders/not-an-id/invoice").set(auth(id()));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, random.body);
  assert.deepEqual(foreign.body, malformed.body);
});

test("18. snapshots exclude provider references and evidence object keys", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  const payment = await Payment.findOne({ subjectId: order._id });
  const evidence = await Evidence.findOne({ subject: order._id }).select("+objectKey");
  await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "ops_manager"));
  const serialized = JSON.stringify(await FinancialDocument.find({ order: order._id }).lean());
  assert.equal(serialized.includes(payment.providerReference), false);
  assert.equal(serialized.includes(evidence.objectKey), false);
});

test("19. a failed verification audit rolls back every financial transition", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  setAuditServiceTestHooks({ beforeWrite: async ({ action }) => {
    if (action === "BANK_TRANSFER_VERIFIED") throw new Error("forced-verification-audit-failure");
  } });
  const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "finance_officer"));
  assert.equal(response.status, 500);
  const storedOrder = await Order.findById(order._id);
  const payment = await Payment.findOne({ subjectId: order._id });
  assert.equal(storedOrder.paymentStatus, "pending");
  assert.equal(payment.status, "PENDING");
  assert.equal(await FinancialDocument.countDocuments({ order: order._id }), 0);
});

test("20. uploading proof never lets the frontend mark an order paid", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await uploadProof(owner, order._id);
  assert.equal(response.status, 201);
  assert.equal(response.body.data.order.paymentStatus, "pending");
  assert.equal(response.body.data.payment.status, "PENDING");
  assert.equal((await Order.findById(order._id)).status, "pending_payment");
});

test("21. concurrent invoice requests persist exactly one immutable snapshot", async () => {
  const owner = id(); const order = await createOrder(owner);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request(app).get(`/api/orders/${order._id}/invoice`).set(auth(owner))),
  );
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.equal(await FinancialDocument.countDocuments({ order: order._id, kind: "INVOICE" }), 1);
});

test("22. mismatched Order and Payment evidence links cannot be verified", async () => {
  const owner = id(); const order = await createOrder(owner);
  await uploadProof(owner, order._id);
  await Order.updateOne({ _id: order._id }, { $set: { paymentEvidence: id() } });
  const response = await request(app).patch(`/api/orders/${order._id}/verify-bank-transfer`).set(auth(id(), "finance_officer"));
  assert.equal(response.status, 404);
  assert.equal((await Payment.findOne({ subjectId: order._id })).status, "PENDING");
});
