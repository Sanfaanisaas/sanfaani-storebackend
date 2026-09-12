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
let sequence = 0;

const ACCESS_SECRET = "customer-returns-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "customer-returns-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "customer-returns-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "customer-returns-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET =
    "customer-returns-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_returns_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `returns_test_${process.pid}_${Date.now()}`,
  });

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

test("1. Order eligibility enforces 14-day window, delivery status, and calculates remaining quantities", async () => {
  const customerId = id();

  const deliveredOrder = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-A",
        nameSnapshot: "Product A",
        quantity: 3,
        priceSnapshot: 10000,
      },
      {
        productId: id(),
        variantSku: "SKU-B",
        nameSnapshot: "Product B",
        quantity: 1,
        priceSnapshot: 5000,
      },
    ],
    subtotal: 35000,
    total: 35000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
  });
  await Order.collection.updateOne(
    { _id: deliveredOrder._id },
    {
      $set: {
        deliveredAt: new Date(Date.now() - 2 * 86400000),
        updatedAt: new Date(Date.now() - 2 * 86400000),
      },
    },
  );

  const pendingOrder = await Order.create({
    userId: customerId,
    status: "processing",
    items: [
      {
        productId: id(),
        variantSku: "SKU-C",
        nameSnapshot: "Product C",
        quantity: 1,
        priceSnapshot: 20000,
      },
    ],
    subtotal: 20000,
    total: 20000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
  });

  const expiredOrder = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-D",
        nameSnapshot: "Product D",
        quantity: 1,
        priceSnapshot: 15000,
      },
    ],
    subtotal: 15000,
    total: 15000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
  });
  await Order.collection.updateOne(
    { _id: expiredOrder._id },
    {
      $set: {
        deliveredAt: new Date(Date.now() - 20 * 86400000),
        updatedAt: new Date(Date.now() - 20 * 86400000),
      },
    },
  );

  const eligibleRes = await req(
    "get",
    `/api/returns/orders/${deliveredOrder._id}/eligibility`,
  ).set(auth(customerId));
  assert.equal(eligibleRes.status, 200);
  assert.equal(eligibleRes.body.data.eligible, true);
  assert.equal(eligibleRes.body.data.eligibleItems.length, 2);

  const pendingRes = await req(
    "get",
    `/api/returns/orders/${pendingOrder._id}/eligibility`,
  ).set(auth(customerId));
  assert.equal(pendingRes.body.data.eligible, false);
  assert.equal(pendingRes.body.data.reasonCode, "ORDER_NOT_RECEIVED");

  const expiredRes = await req(
    "get",
    `/api/returns/orders/${expiredOrder._id}/eligibility`,
  ).set(auth(customerId));
  assert.equal(expiredRes.body.data.eligible, false);
  assert.equal(expiredRes.body.data.reasonCode, "WINDOW_EXPIRED");
});

test("2. Return creation enforces idempotency, fingerprints, and sequentially prevents overselling", async () => {
  const customerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-X",
        nameSnapshot: "Product X",
        quantity: 2,
        priceSnapshot: 10000,
      },
    ],
    subtotal: 20000,
    total: 20000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
    deliveredAt: new Date(Date.now() - 1 * 86400000),
  });

  // Try returning 3 when only 2 exist
  const overQtyRes = await req("post", `/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-over")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 3 }],
      reason: "Defective",
    });
  assert.equal(overQtyRes.status, 409);

  // Valid return for 1
  const createRes1 = await req("post", `/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 1 }],
      reason: "Defective",
    });
  assert.equal(createRes1.status, 201);
  assert.equal(createRes1.body.data.status, "SUBMITTED");

  // Idempotent replay
  const replayRes = await req("post", `/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 1 }],
      reason: "Defective",
    });
  assert.equal(replayRes.status, 201);
  assert.equal(replayRes.body.data.id, createRes1.body.data.id);

  // Fingerprint conflict
  const conflictFingerprintRes = await req(
    "post",
    `/api/returns/orders/${order._id}`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-1")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 1 }],
      reason: "Different reason.",
    });
  assert.equal(conflictFingerprintRes.status, 409);

  // Return the remaining 1
  const createRes2 = await req("post", `/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-2")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 1 }],
      reason: "Second unit defective.",
    });
  assert.equal(createRes2.status, 201);

  // Try returning a 3rd (exhausted)
  const exceedRemainingRes = await req(
    "post",
    `/api/returns/orders/${order._id}`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", "key-ret-3")
    .send({
      items: [{ variantSku: "SKU-X", quantity: 1 }],
      reason: "Third unit attempted.",
    });
  assert.equal(exceedRemainingRes.status, 409);
});

test("3. Concurrent duplicate requests (double-clicks) are safely resolved by Idempotency controls", async () => {
  const customerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-DBL",
        nameSnapshot: "Product",
        quantity: 1,
        priceSnapshot: 10000,
      },
    ],
    subtotal: 10000,
    total: 10000,
    paymentMethod: "paystack",
    shippingAddress: {
      street: "1 Main",
      city: "Lagos",
      state: "LA",
      country: "NG",
    },
    deliveredAt: new Date(Date.now() - 1 * 86400000),
  });

  const sharedKey = next("dbl-click");

  // Launch 2 requests at the exact same millisecond with the SAME idempotency key
  const [res1, res2] = await Promise.all([
    req("post", `/api/returns/orders/${order._id}`)
      .set(auth(customerId))
      .set("Idempotency-Key", sharedKey)
      .send({
        items: [{ variantSku: "SKU-DBL", quantity: 1 }],
        reason: "Double click test",
      }),
    req("post", `/api/returns/orders/${order._id}`)
      .set(auth(customerId))
      .set("Idempotency-Key", sharedKey)
      .send({
        items: [{ variantSku: "SKU-DBL", quantity: 1 }],
        reason: "Double click test",
      }),
  ]);

  // The first request will succeed (201).
  // The concurrent request hits the 11000 DB index constraint, catches the error, but sees null because
  // the first transaction hasn't fully committed yet, resulting in a safe 409 Conflict.
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const dbCount = await ReturnRequest.countDocuments({
    owner: customerId,
    order: order._id,
  });
  assert.equal(dbCount, 1); // Proven! Only one was created.
});

test("4. Customer isolation: Foreign and malformed identifiers return non-enumerating 404s", async () => {
  const customerId = id();
  const otherId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-Z",
        nameSnapshot: "Product Z",
        quantity: 1,
        priceSnapshot: 1000,
      },
    ],
    subtotal: 1000,
    total: 1000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
    deliveredAt: new Date(),
  });

  const foreignRes = await req(
    "get",
    `/api/returns/orders/${order._id}/eligibility`,
  ).set(auth(otherId));
  assert.equal(foreignRes.status, 404);

  const randomRes = await req(
    "get",
    `/api/returns/orders/${id()}/eligibility`,
  ).set(auth(customerId));
  assert.equal(randomRes.status, 404);

  const malformedRes = await req(
    "get",
    "/api/returns/orders/invalid-id/eligibility",
  ).set(auth(customerId));
  assert.equal(
    [400, 422].includes(malformedRes.status),
    true,
    `Expected 400 or 422, got ${malformedRes.status}`,
  );
});

test("5. Staff FSM strictly enforces the transition graph, roles, and sends notifications", async () => {
  const customerId = id();
  const staffId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-Y",
        nameSnapshot: "Product Y",
        quantity: 1,
        priceSnapshot: 12000,
      },
    ],
    subtotal: 12000,
    total: 12000,
    paymentMethod: "bank_transfer",
    shippingAddress: {
      street: "1 Main St",
      city: "Lagos",
      state: "LA",
      country: "Nigeria",
    },
    deliveredAt: new Date(Date.now() - 1 * 86400000),
  });

  const createRes = await req("post", `/api/returns/orders/${order._id}`)
    .set(auth(customerId))
    .set("Idempotency-Key", next("decisions"))
    .send({
      items: [{ variantSku: "SKU-Y", quantity: 1 }],
      reason: "Faulty charging port",
    });
  const returnId = createRes.body.data.id;

  // Customer cannot change status
  const customerPatch = await req("patch", `/api/returns/${returnId}/decision`)
    .set(auth(customerId, "customer"))
    .send({ status: "APPROVED" });
  assert.equal(customerPatch.status, 403);

  // Illegal transition: SUBMITTED -> RESOLVED
  const invalidStep = await req("patch", `/api/returns/${returnId}/decision`)
    .set(auth(staffId, "support_officer"))
    .send({ status: "RESOLVED" });
  assert.equal(invalidStep.status, 409);

  // Valid transition: SUBMITTED -> APPROVED
  const validDecision = await req("patch", `/api/returns/${returnId}/decision`)
    .set(auth(staffId, "support_officer"))
    .send({
      status: "APPROVED",
      remedy: "refund",
      nextAction: "Ship the item back.",
    });
  assert.equal(validDecision.status, 200);
  assert.equal(validDecision.body.data.status, "APPROVED");

  // Verify Notification was sent
  const notifCount = await Notification.countDocuments({
    recipient: customerId,
    type: "return_status_updated",
  });
  assert.equal(notifCount, 1);

  // Transition to CANCELLED and test stale edits
  await ReturnRequest.updateOne(
    { _id: returnId },
    { $set: { status: "CANCELLED" } },
  );
  const staleDecision = await req("patch", `/api/returns/${returnId}/decision`)
    .set(auth(staffId, "support_officer"))
    .send({ status: "RESOLVED" });
  assert.equal(staleDecision.status, 409); // Cannot transition OUT of Cancelled
});

test("6. Optimistic Concurrency Control (OCC) prevents race conditions during staff decisions", async () => {
  const customerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-OCC",
        nameSnapshot: "Product",
        quantity: 1,
        priceSnapshot: 1000,
      },
    ],
    subtotal: 1000,
    total: 1000,
    paymentMethod: "paystack",
    shippingAddress: {
      street: "1 Main",
      city: "Lagos",
      state: "LA",
      country: "NG",
    },
    deliveredAt: new Date(),
  });

  const ret = await ReturnRequest.create({
    order: order._id,
    owner: customerId,
    items: [{ variantSku: "SKU-OCC", quantity: 1 }],
    reason: "Testing OCC",
    status: "SUBMITTED",
  });

  // Two staff members try to update the exact same return at the exact same millisecond
  const [res1, res2] = await Promise.all([
    req("patch", `/api/returns/${ret._id}/decision`)
      .set(auth(id(), "support_officer"))
      .send({ status: "INSPECTION_REQUIRED" }),
    req("patch", `/api/returns/${ret._id}/decision`)
      .set(auth(id(), "support_officer"))
      .send({ status: "APPROVED" }),
  ]);

  // One MUST succeed (200), one MUST hit the OCC block (409)
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  // The database should have strictly transitioned to the winning state
  const dbRet = await ReturnRequest.findById(ret._id);
  assert.equal(
    ["INSPECTION_REQUIRED", "APPROVED"].includes(dbRet.status),
    true,
  );
});
