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
let ReturnRequest;
let Notification;
let replicaSet;

const ACCESS_SECRET = "customer-returns-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "customer-returns-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "customer-returns-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "customer-returns-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "customer-returns-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_returns_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `returns_test_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: ReturnRequest } = await import("../models/ReturnRequest.js"));
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

test("return eligibility calculation, status checks, and non-enumeration", async () => {
  const customerId = id();
  const otherId = id();

  const deliveredOrder = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      { productId: new mongoose.Types.ObjectId(), variantSku: "SKU-A", nameSnapshot: "Product A", quantity: 3, priceSnapshot: 10000 },
      { productId: new mongoose.Types.ObjectId(), variantSku: "SKU-B", nameSnapshot: "Product B", quantity: 1, priceSnapshot: 5000 },
    ],
    subtotal: 35000,
    total: 35000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
    deliveredAt: new Date(Date.now() - 2 * 86400000),
  });

  const pendingOrder = await Order.create({
    userId: customerId,
    status: "processing",
    items: [{ productId: new mongoose.Types.ObjectId(), variantSku: "SKU-C", nameSnapshot: "Product C", quantity: 1, priceSnapshot: 20000 }],
    subtotal: 20000,
    total: 20000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
  });

  const expiredOrder = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [{ productId: new mongoose.Types.ObjectId(), variantSku: "SKU-D", nameSnapshot: "Product D", quantity: 1, priceSnapshot: 15000 }],
    subtotal: 15000,
    total: 15000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
  });
  await Order.collection.updateOne({ _id: expiredOrder._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 86400000) } });

  const eligibleRes = await request(app).get(`/api/returns/orders/${deliveredOrder._id}/eligibility`).set(auth(customerId));
  assert.equal(eligibleRes.status, 200);
  assert.equal(eligibleRes.body.data.eligible, true);
  assert.equal(eligibleRes.body.data.eligibleItems.length, 2);

  const pendingRes = await request(app).get(`/api/returns/orders/${pendingOrder._id}/eligibility`).set(auth(customerId));
  assert.equal(pendingRes.body.data.eligible, false);
  assert.equal(pendingRes.body.data.reasonCode, "ORDER_NOT_RECEIVED");

  const expiredRes = await request(app).get(`/api/returns/orders/${expiredOrder._id}/eligibility`).set(auth(customerId));
  assert.equal(expiredRes.body.data.eligible, false);
  assert.equal(expiredRes.body.data.reasonCode, "WINDOW_EXPIRED");

  const foreignRes = await request(app).get(`/api/returns/orders/${deliveredOrder._id}/eligibility`).set(auth(otherId));
  assert.equal(foreignRes.status, 404);
  assert.equal(foreignRes.body.errors[0].code, "return_eligibility_unavailable");

  const randomRes = await request(app).get(`/api/returns/orders/${id()}/eligibility`).set(auth(customerId));
  assert.equal(randomRes.status, 404);

  const malformedRes = await request(app).get("/api/returns/orders/invalid-id/eligibility").set(auth(customerId));
  assert.equal(malformedRes.status, 400);
});

test("return creation, quantity accounting, idempotency, and concurrent quantity protection", async () => {
  const customerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      { productId: new mongoose.Types.ObjectId(), variantSku: "SKU-X", nameSnapshot: "Product X", quantity: 2, priceSnapshot: 10000 },
    ],
    subtotal: 20000,
    total: 20000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
    deliveredAt: new Date(Date.now() - 1 * 86400000),
  });

  const overQtyRes = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-over")
    .send({ items: [{ variantSku: "SKU-X", quantity: 3 }], reason: "Product defective upon arrival" });
  assert.equal(overQtyRes.status, 409);

  const createRes1 = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({ items: [{ variantSku: "SKU-X", quantity: 1 }], reason: "Product defective upon arrival" });
  assert.equal(createRes1.status, 201);
  assert.equal(createRes1.body.data.status, "SUBMITTED");

  const replayRes = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({ items: [{ variantSku: "SKU-X", quantity: 1 }], reason: "Product defective upon arrival" });
  assert.equal(replayRes.status, 201);
  assert.equal(replayRes.body.data.id, createRes1.body.data.id);

  const conflictFingerprintRes = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({ items: [{ variantSku: "SKU-X", quantity: 1 }], reason: "Different reason for same key." });
  assert.equal(conflictFingerprintRes.status, 409);

  const createRes2 = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-2")
    .send({ items: [{ variantSku: "SKU-X", quantity: 1 }], reason: "Second unit also defective." });
  assert.equal(createRes2.status, 201);

  const exceedRemainingRes = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-3")
    .send({ items: [{ variantSku: "SKU-X", quantity: 1 }], reason: "Third unit attempted but only 2 purchased." });
  assert.equal(exceedRemainingRes.status, 409);
  assert.equal(exceedRemainingRes.body.errors[0].code, "return_ineligible");
});

test("return staff decisions, transitions, role enforcement, and concurrency protection", async () => {
  const customerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [{ productId: new mongoose.Types.ObjectId(), variantSku: "SKU-Y", nameSnapshot: "Product Y", quantity: 1, priceSnapshot: 12000 }],
    subtotal: 12000,
    total: 12000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
    deliveredAt: new Date(Date.now() - 1 * 86400000),
  });

  const createRes = await request(app)
    .post(`/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-decision")
    .send({ items: [{ variantSku: "SKU-Y", quantity: 1 }], reason: "Faulty charging port" });
  const returnId = createRes.body.data.id;

  const customerPatch = await request(app)
    .patch(`/api/returns/${returnId}/decision`)
    .set(auth(customerId, "customer"))
    .send({ status: "APPROVED" });
  assert.equal(customerPatch.status, 403);

  const invalidStep = await request(app)
    .patch(`/api/returns/${returnId}/decision`)
    .set(auth(id(), "support_officer"))
    .send({ status: "RESOLVED" });
  assert.equal(invalidStep.status, 409);

  const validDecision = await request(app)
    .patch(`/api/returns/${returnId}/decision`)
    .set(auth(id(), "support_officer"))
    .send({ status: "APPROVED", remedy: "refund", nextAction: "Ship the item back using provided label." });
  assert.equal(validDecision.status, 200);
  assert.equal(validDecision.body.data.status, "APPROVED");
  assert.equal(validDecision.body.data.remedy, "refund");

  const notifCount = await Notification.countDocuments({ recipient: customerId, type: "return_status_updated" });
  assert.equal(notifCount, 1);

  await ReturnRequest.updateOne({ _id: returnId }, { $set: { status: "CANCELLED" } });

  const staleDecision = await request(app)
    .patch(`/api/returns/${returnId}/decision`)
    .set(auth(id(), "support_officer"))
    .send({ status: "RESOLVED" });
  assert.equal(staleDecision.status, 409);
});
