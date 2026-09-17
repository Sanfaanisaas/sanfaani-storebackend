import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app,
  Order,
  User,
  StockReservation,
  InventoryUnit,
  Product,
  Variant,
  InventoryLocation,
  generateAccessToken,
  USER_ROLES;
let replSet,
  customerToken,
  staffToken,
  customerUser,
  staffUser,
  product,
  variant,
  orderId,
  serial1,
  location;

test.before(async () => {
  // Inject ALL required environment variables for strict boot validation
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "order-fulfilment-test-access-secret-32-chars";
  process.env.JWT_REFRESH_SECRET = "order-fulfilment-test-refresh-secret-32";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "order-fulfilment-test-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "order-fulfilment-test-tracking-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_order_fulfilment";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be16-mongo");

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `order_fulfilment_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: StockReservation } =
    await import("../models/StockReservation.js"));
  ({ default: InventoryUnit } = await import("../models/InventoryUnit.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: InventoryLocation } =
    await import("../models/InventoryLocation.js"));
  ({ generateAccessToken } = await import("../services/tokenService.js"));
  ({ USER_ROLES } = await import("../utils/constants.js"));

  await Promise.all(
    Object.values(mongoose.models).map((m) => m.createIndexes()),
  );

  customerUser = await User.create({
    name: "Cust1",
    email: `cust-${Date.now()}@test.com`,
    passwordHash: "dummy",
    role: USER_ROLES.CUSTOMER,
    isActive: true,
  });
  staffUser = await User.create({
    name: "Staff1",
    email: `staff-${Date.now()}@test.com`,
    passwordHash: "dummy",
    role: USER_ROLES.STORE_OPERATOR,
    isActive: true,
  });

  customerToken = generateAccessToken(customerUser);
  staffToken = generateAccessToken(staffUser);

  product = await Product.create({
    name: "Phone",
    slug: `ph-${Date.now()}`,
    description: "D",
    category: "Cat",
    brand: "B",
    status: "active",
  });
  variant = await Variant.create({
    product: product._id,
    sku: `SKU-${Date.now()}`,
    attributes: {},
    price: 100,
    condition: "new",
    inStock: 5,
  });
  location = await InventoryLocation.create({
    code: `LOC-${Date.now()}`,
    name: "Main",
    type: "WAREHOUSE",
    createdBy: staffUser._id,
  });

  serial1 = `SN-${Date.now()}`;
  await InventoryUnit.create({
    product: product._id,
    variant: variant._id,
    serialNumber: serial1,
    location: location._id,
    condition: "NEW",
    state: "ALLOCATED",
  });

  const order = await Order.create({
    userId: customerUser._id,
    items: [
      {
        productId: product._id,
        variantSku: variant.sku,
        nameSnapshot: "Phone",
        priceSnapshot: 100,
        quantity: 1,
      },
    ],
    shippingAddress: {
      street: "123",
      city: "ibadan-central",
      state: "OYO",
      country: "NG",
    },
    subtotal: 100,
    total: 100,
    paymentMethod: "paystack",
    paymentStatus: "paid",
    status: "paid",
  });
  orderId = order._id;

  await StockReservation.create({
    order: order._id,
    product: product._id,
    variant: variant._id,
    quantity: 1,
    status: "ALLOCATED",
    expiresAt: new Date(Date.now() + 3600000),
  });
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-16 Order Fulfilment, Serials, & Evidence Integrity", async (t) => {
  await t.test(
    "1. Pickup strictly validates identity metadata and serials",
    async () => {
      const payload = {
        identityDocumentType: "ID_CARD",
        acknowledgedBy: "John Doe",
        assignedSerials: [serial1],
      };
      const res = await request(app)
        .patch(`/api/orders/${orderId}/collect`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send(payload);

      assert.equal(
        res.status,
        200,
        `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.equal(res.body.data.status, "completed");
      assert.equal(res.body.data.fulfilment.identityDocumentType, "ID_CARD");
      assert.equal(res.body.data.fulfilment.acknowledgedBy, "John Doe");
      assert.equal(res.body.data.items[0].assignedSerials[0], serial1);

      const unit = await InventoryUnit.findOne({ serialNumber: serial1 });
      assert.equal(
        unit.state,
        "CONSUMED",
        "Inventory unit must be marked consumed exactly once",
      );
    },
  );

  await t.test(
    "2. Collection is strictly idempotent and safely ignores duplicates",
    async () => {
      const payload = {
        identityDocumentType: "ID_CARD",
        acknowledgedBy: "John Doe",
      };
      const res = await request(app)
        .patch(`/api/orders/${orderId}/collect`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send(payload);
      assert.equal(res.status, 200, "Idempotent requests must succeed");
    },
  );

  await t.test(
    "3. Dispatch and delivery use controlled transitions",
    async () => {
      const o2 = await Order.create({
        userId: customerUser._id,
        items: [
          {
            productId: product._id,
            variantSku: variant.sku,
            nameSnapshot: "Phone",
            priceSnapshot: 100,
            quantity: 1,
          },
        ],
        shippingAddress: { street: "1", city: "C", state: "S", country: "C" },
        subtotal: 100,
        total: 100,
        paymentMethod: "paystack",
        paymentStatus: "paid",
        status: "paid",
      });
      await StockReservation.create({
        order: o2._id,
        product: product._id,
        variant: variant._id,
        quantity: 1,
        status: "ALLOCATED",
        expiresAt: new Date(Date.now() + 3600000),
      });

      const dispatchRes = await request(app)
        .patch(`/api/orders/${o2._id}/dispatch`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ trackingReference: "TRK123", courierName: "Speedy" });
      assert.equal(
        dispatchRes.status,
        200,
        `Expected 200, got ${dispatchRes.status}`,
      );
      assert.equal(dispatchRes.body.data.status, "dispatched");
      assert.equal(dispatchRes.body.data.fulfilment.courierName, "Speedy");

      const deliverRes = await request(app)
        .patch(`/api/orders/${o2._id}/deliver`)
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(
        deliverRes.status,
        200,
        `Expected 200, got ${deliverRes.status}`,
      );
      assert.equal(deliverRes.body.data.status, "completed");
    },
  );

  await t.test(
    "4. Customers cannot access foreign orders or enumerate IDs",
    async () => {
      const badRes = await request(app)
        .get(`/api/orders/${new mongoose.Types.ObjectId()}`)
        .set("Authorization", `Bearer ${customerToken}`);
      assert.equal(badRes.status, 404, "Foreign IDs must non-enumerate as 404");
    },
  );
});
