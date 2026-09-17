import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Product;
let Variant;
let Order;
let Payment;
let StockReservation;
let AuditLog;
let expireReservations;
let setPaystackProviderForTests;
let resetPaystackProviderForTests;
let replicaSet;
let sequence = 0;
const ACCESS_SECRET = "fulfilment-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (userId, role = "customer") => ({ Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const clear = async () => { for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({}); };
const address = { street: "1 Fulfilment Street", city: "Lagos", state: "LA", country: "NG" };
const createAggregate = async (stock = 2) => {
  const product = await Product.create({ name: `Fulfilment product ${next("product")}`, slug: `fulfilment-${next("slug")}`, description: "Fulfilment fixture", category: "Phones", brand: "Sanfaani", images: ["https://example.test/product.jpg"], status: "active" });
  const variant = await Variant.create({ product: product._id, sku: `FULFIL-${next("sku")}`, attributes: { colour: "black" }, price: 1000, condition: "new", inStock: stock });
  return { product, variant };
};
const checkout = async (owner, aggregate, key) => {
  assert.equal((await request(app).post("/api/cart/items").set(auth(owner)).send({ productId: aggregate.product._id.toString(), variantSku: aggregate.variant.sku, quantity: 1 })).status, 200);
  return request(app).post("/api/checkout").set(auth(owner)).set("Idempotency-Key", key).send({ shippingAddress: address, paymentMethod: "paystack" });
};
const settle = (payment) => request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("X-Paystack-Signature", "signed")
  .send({ event: "charge.success", data: { id: next("charge"), reference: payment.providerReference, amount: payment.amount, currency: payment.currency, metadata: { subjectType: payment.subjectType, subjectId: payment.subjectId.toString(), owner: payment.owner.toString(), purpose: payment.purpose, quoteVersion: payment.quoteVersion } } });

test.before(async () => {
  process.env.NODE_ENV = "test"; process.env.JWT_SECRET = ACCESS_SECRET; process.env.JWT_REFRESH_SECRET = "fulfilment-refresh-secret-at-least-32-characters"; process.env.SECURITY_AUDIT_HMAC_SECRET = "fulfilment-audit-secret-at-least-32-characters"; process.env.REPAIR_TRACKING_TOKEN_SECRET = "fulfilment-tracking-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test"; process.env.PAYSTACK_SECRET_KEY = "sk_test_fulfilment_contract"; process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback"; process.env.SENTRY_DSN = "https://example.test/sentry/1"; process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be08-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } }); process.env.MONGO_URI = replicaSet.getUri(); await mongoose.connect(process.env.MONGO_URI, { dbName: `fulfilment_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js")); ({ default: Product } = await import("../models/Product.js")); ({ default: Variant } = await import("../models/Variant.js")); ({ default: Order } = await import("../models/Order.js")); ({ default: Payment } = await import("../models/Payment.js")); ({ default: StockReservation } = await import("../models/StockReservation.js")); ({ default: AuditLog } = await import("../models/AuditLog.js")); ({ expireReservations } = await import("../services/reservationService.js")); ({ setPaystackProviderForTests, resetPaystackProviderForTests } = await import("../services/paystackProvider.js"));
  setPaystackProviderForTests({ initializePayment: async (input) => ({ authorizationUrl: "https://fake.example/pay", reference: input.reference }), verifyWebhookSignature: (_raw, signature) => signature === "signed", verifyTransaction: async () => { throw new Error("no provider verification"); }, requestRefund: async () => { throw new Error("no provider refund"); }, verifyRefund: async () => { throw new Error("no provider refund"); } });
  await mongoose.syncIndexes();
});
test.beforeEach(clear);
test.after(async () => { resetPaystackProviderForTests(); if (mongoose.connection.readyState) await mongoose.disconnect(); await replicaSet?.stop(); });

test("checkout reserves inventory, verified payment allocates it, and dispatch consumes it exactly once", async () => {
  const owner = id(); const operator = id(); const aggregate = await createAggregate(1);
  const response = await checkout(owner, aggregate, "fulfil-reserve"); assert.equal(response.status, 201);
  const order = await Order.findById(response.body.data.id); const reserved = await StockReservation.findOne({ order: order._id });
  assert.equal(reserved.status, "RESERVED"); assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 0);
  const paymentAttempt = await request(app).post("/api/payments/attempts").set(auth(owner)).set("Idempotency-Key", "fulfil-payment").send({ subjectType: "order", subjectId: order._id.toString() });
  const payment = await Payment.findById(paymentAttempt.body.data.paymentId); assert.equal((await settle(payment)).status, 200);
  assert.equal((await StockReservation.findById(reserved._id)).status, "ALLOCATED");
  const dispatched = await request(app).patch(`/api/orders/${order._id}/dispatch`).set(auth(operator, "store_operator")); assert.equal(dispatched.status, 200);
  assert.equal((await StockReservation.findById(reserved._id)).status, "CONSUMED"); assert.equal((await Order.findById(order._id)).status, "dispatched");
  assert.equal((await request(app).patch(`/api/orders/${order._id}/dispatch`).set(auth(operator, "store_operator"))).status, 200);
  assert.equal(await AuditLog.countDocuments({ action: "INVENTORY_ALLOCATED" }), 1); assert.equal(await AuditLog.countDocuments({ action: "ORDER_DISPATCHED" }), 1);
});

test("cancellation and expiry release held stock without a duplicate release", async () => {
  const owner = id(); const aggregate = await createAggregate(2); const response = await checkout(owner, aggregate, "fulfil-cancel"); const order = await Order.findById(response.body.data.id);
  assert.equal((await request(app).patch(`/api/orders/${order._id}/cancel`).set(auth(owner))).status, 200);
  assert.equal((await StockReservation.findOne({ order: order._id })).status, "RELEASED"); assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 2);
  assert.equal((await request(app).patch(`/api/orders/${order._id}/cancel`).set(auth(owner))).status, 200);
  const second = await checkout(owner, aggregate, "fulfil-expiry"); const expiring = await StockReservation.findOne({ order: second.body.data.id });
  await StockReservation.updateOne({ _id: expiring._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  assert.deepEqual(await expireReservations(new Date(), id()), { released: 1 });
  assert.equal((await StockReservation.findById(expiring._id)).status, "EXPIRED"); assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 2);
});

test("fulfilment requires a paid allocation and staff authorization", async () => {
  const owner = id(); const aggregate = await createAggregate(1); const response = await checkout(owner, aggregate, "fulfil-gates"); const orderId = response.body.data.id;
  assert.equal((await request(app).patch(`/api/orders/${orderId}/dispatch`).set(auth(owner, "customer"))).status, 403);
  assert.equal((await request(app).patch(`/api/orders/${orderId}/dispatch`).set(auth(id(), "store_operator"))).status, 409);
});

test("a verified failed payment callback releases its reservation exactly once", async () => {
  const owner = id(); const aggregate = await createAggregate(1); const response = await checkout(owner, aggregate, "fulfil-failed-payment"); const orderId = response.body.data.id;
  const attempt = await request(app).post("/api/payments/attempts").set(auth(owner)).set("Idempotency-Key", "fulfil-failed-attempt").send({ subjectType: "order", subjectId: orderId });
  const payment = await Payment.findById(attempt.body.data.paymentId);
  const callback = { event: "charge.failed", data: { id: next("failed-charge"), reference: payment.providerReference, amount: payment.amount, currency: payment.currency, metadata: { subjectType: payment.subjectType, subjectId: payment.subjectId.toString(), owner: payment.owner.toString(), purpose: payment.purpose, quoteVersion: payment.quoteVersion } } };
  assert.equal((await request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("X-Paystack-Signature", "signed").send(callback)).status, 200);
  assert.equal((await Payment.findById(payment._id)).status, "FAILED"); assert.equal((await StockReservation.findOne({ order: orderId })).status, "RELEASED"); assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 1);
  assert.equal((await request(app).post("/api/payments/webhook").set("Content-Type", "application/json").set("X-Paystack-Signature", "signed").send(callback)).status, 200);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 1);
});
