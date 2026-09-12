import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";
import AppError from "../utils/AppError.js";
import Cart from "../models/Cart.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockLedger from "../models/StockLedger.js";
import Variant from "../models/Variant.js";
import { PRODUCT_STATUS } from "../utils/constants.js";

let app;
let errorHandler;
let runtimeEnv;
let setCheckoutTestHooks;
let memoryReplicaSet;
let fixtureSequence = 0;

const ACCESS_SECRET = "cart-checkout-test-access-secret-at-least-32-chars";
const userId = (suffix = 1) => new mongoose.Types.ObjectId(
  `64b000000000000000000${String(suffix).padStart(3, "0")}`,
);
const auth = (id = userId()) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: id.toString(), role: "customer", type: "access" },
    ACCESS_SECRET,
    { algorithm: "HS256", expiresIn: "15m" },
  )}`,
});

const checkoutBody = (overrides = {}) => ({
  shippingAddress: {
    street: "1 Test Street",
    city: "Lagos",
    state: "Lagos",
    postalCode: "100001",
    country: "NG",
    ...(overrides.shippingAddress ?? {}),
  },
  paymentMethod: overrides.paymentMethod ?? "paystack",
});

const errorKeys = (body) => Object.keys(body).sort();
const assertErrorEnvelope = (body) => {
  assert.deepEqual(errorKeys(body), ["errors", "message", "success"]);
  assert.equal(body.success, false);
  assert.equal(typeof body.message, "string");
  assert.ok(Array.isArray(body.errors));
};

const createAggregate = async ({
  status = PRODUCT_STATUS.ACTIVE,
  price = 100,
  inStock = 10,
  sourcing,
  sku,
} = {}) => {
  fixtureSequence += 1;
  const suffix = fixtureSequence;
  const product = await Product.create({
    name: `BE-02 Product ${suffix}`,
    slug: `be-02-product-${suffix}`,
    description: "BE-02 route fixture",
    category: "Phones",
    brand: "Sanfaani",
    images: ["https://example.test/product.jpg"],
    status,
  });
  const variant = await Variant.create({
    product: product._id,
    sku: sku ?? `BE02-SKU-${suffix}`,
    attributes: { colour: "Black" },
    price,
    condition: "new",
    ...(sourcing
      ? { sourcing: { supplier: "Test Supplier", leadTimeDays: 2, costPrice: 50 } }
      : { inStock }),
  });
  return { product, variant };
};

const postCart = (aggregate, quantity = 1, id = userId()) => request(app)
  .post("/api/cart/items")
  .set(auth(id))
  .send({
    productId: aggregate.product._id.toString(),
    variantSku: aggregate.variant.sku,
    quantity,
  });

const postCheckout = (key, id = userId(), body = checkoutBody()) => request(app)
  .post("/api/checkout")
  .set(auth(id))
  .set("Idempotency-Key", key)
  .send(body);

const seedCart = async (id, lines) => Cart.collection.insertOne({
  userId: id,
  items: lines,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const cartLine = (aggregate, overrides = {}) => ({
  productId: aggregate.product._id,
  variantSku: aggregate.variant.sku,
  quantity: 1,
  priceAtAdd: aggregate.variant.price,
  ...overrides,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "cart-checkout-test-refresh-secret-at-least-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "cart-checkout-test-audit-hmac-secret-at-least-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_cart_checkout_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-mongodb-binaries");
  delete process.env.TEST_MONGO_URI;

  memoryReplicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = memoryReplicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `cart_checkout_contract_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ errorHandler } = await import("../middleware/errorHandler.js"));
  ({ env: runtimeEnv } = await import("../config/env.js"));
  ({ setCheckoutTestHooks } = await import("../controllers/checkoutController.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setCheckoutTestHooks({});
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  setCheckoutTestHooks({});
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (memoryReplicaSet) await memoryReplicaSet.stop();
});

test("1. Uniform error envelope across environments", async () => {
  const originalMode = runtimeEnv.nodeEnv;
  for (const mode of ["development", "test", "production"]) {
    runtimeEnv.nodeEnv = mode;
    const response = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    errorHandler(new AppError("Safe failure", 409, [{ code: "safe_detail" }]), {}, response);
    assert.equal(response.statusCode, 409);
    assertErrorEnvelope(response.body);
    assert.deepEqual(response.body.errors, [{ code: "safe_detail" }]);
  }
  runtimeEnv.nodeEnv = originalMode;

  const zodFailure = await request(app).post("/api/cart/items").set(auth()).send({});
  assert.equal(zodFailure.status, 422);
  assertErrorEnvelope(zodFailure.body);
  assert.ok(zodFailure.body.errors.every((detail) => detail.field && detail.code));

  const missingRoute = await request(app).get("/api/does-not-exist");
  assert.equal(missingRoute.status, 404);
  assertErrorEnvelope(missingRoute.body);
});

test("2. No raw error or stack leakage", async () => {
  const malformed = await request(app)
    .post("/api/auth/login")
    .set("Content-Type", "application/json")
    .send('{"email":');
  assert.equal(malformed.status, 400);
  assertErrorEnvelope(malformed.body);
  assert.equal(malformed.body.errors[0].code, "malformed_json");

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = {
      body: null,
      status() { return this; },
      json(body) { this.body = body; return this; },
    };
    errorHandler(new Error("secret database detail"), {}, response);
    assertErrorEnvelope(response.body);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("secret database detail"), false);
    assert.equal(serialized.includes("stack"), false);
    assert.equal(serialized.includes("Mongo"), false);
  } finally {
    console.error = originalConsoleError;
  }

  const duplicateAggregate = await createAggregate();
  await assert.rejects(
    () => Cart.create({ userId: userId(), items: [] }).then(
      () => Cart.create({ userId: userId(), items: [] }),
    ),
    (error) => error.code === 11000,
  );
  assert.ok(duplicateAggregate.product);
});

test("3. Cart addition stores trusted priceAtAdd", async () => {
  const aggregate = await createAggregate({ price: 125000 });
  const response = await postCart(aggregate);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.items[0].priceAtAdd, 125000);
  assert.equal((await Cart.findOne({ userId: userId() })).items[0].priceAtAdd, 125000);
});

test("4. Repeated POST increments existing quantity", async () => {
  const aggregate = await createAggregate({ inStock: 5 });
  assert.equal((await postCart(aggregate)).status, 200);
  const second = await postCart(aggregate);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.items[0].quantity, 2);
});

test("5. PATCH sets exact quantity and refreshes price snapshot", async () => {
  const aggregate = await createAggregate({ price: 100, inStock: 10 });
  await postCart(aggregate, 2);
  aggregate.variant.price = 120;
  await aggregate.variant.save();

  const response = await request(app)
    .patch(`/api/cart/items/${aggregate.variant.sku}`)
    .set(auth())
    .send({ quantity: 4 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.items[0].quantity, 4);
  assert.equal(response.body.data.items[0].priceAtAdd, 120);
});

test("6. Product and variant ownership mismatch is rejected", async () => {
  const first = await createAggregate();
  const second = await createAggregate();
  const response = await request(app)
    .post("/api/cart/items")
    .set(auth())
    .send({
      productId: second.product._id.toString(),
      variantSku: first.variant.sku,
      quantity: 1,
    });
  assert.equal(response.status, 409);
  assertErrorEnvelope(response.body);
  assert.equal(response.body.errors[0].type, "ownership_mismatch");
  assert.equal(await Cart.countDocuments(), 0);
});

test("7. Sourcing-only and inactive products are rejected", async () => {
  const sourcing = await createAggregate({ sourcing: true });
  const inactive = await createAggregate({ status: PRODUCT_STATUS.ARCHIVED });
  const sourcingResponse = await postCart(sourcing);
  const inactiveResponse = await postCart(inactive);
  assert.equal(sourcingResponse.status, 409);
  assert.equal(inactiveResponse.status, 409);
  assert.equal(sourcingResponse.body.errors[0].type, "sourcing_unavailable");
  assert.equal(inactiveResponse.body.errors[0].type, "product_inactive");
});

test("8. Actual frontend guestItems payload is accepted", async () => {
  const aggregate = await createAggregate({ price: 300, inStock: 5 });
  const response = await request(app)
    .post("/api/cart/merge")
    .set(auth())
    .send({ guestItems: [{ variantId: aggregate.variant._id.toString(), quantity: 2 }] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.items[0].quantity, 2);
  assert.equal(response.body.data.items[0].priceAtAdd, 300);
});

test("9. Duplicate guest lines are consolidated deterministically", async () => {
  const aggregate = await createAggregate({ inStock: 10 });
  const response = await request(app)
    .post("/api/cart/merge")
    .set(auth())
    .send({ guestItems: [
      { variantId: aggregate.variant._id.toString(), quantity: 1 },
      { variantId: aggregate.variant._id.toString(), quantity: 2 },
    ] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.items.length, 1);
  assert.equal(response.body.data.items[0].quantity, 3);
});

test("10. Conflicting merge performs zero partial writes", async () => {
  const existing = await createAggregate({ inStock: 10 });
  const validGuest = await createAggregate({ inStock: 10 });
  const badGuest = await createAggregate({ inStock: 1, price: 500 });
  await postCart(existing);
  const before = (await Cart.findOne({ userId: userId() })).toObject();

  const response = await request(app)
    .post("/api/cart/merge")
    .set(auth())
    .send({ guestItems: [
      { variantId: validGuest.variant._id.toString(), quantity: 1 },
      { variantId: badGuest.variant._id.toString(), quantity: 2, price: 400 },
    ] });
  assert.equal(response.status, 409);
  assert.deepEqual(
    new Set(response.body.errors.map(({ type }) => type)),
    new Set(["insufficient_stock", "price_changed"]),
  );
  const after = (await Cart.findOne({ userId: userId() })).toObject();
  assert.deepEqual(after.items.map(({ variantSku, quantity }) => ({ variantSku, quantity })),
    before.items.map(({ variantSku, quantity }) => ({ variantSku, quantity })));
});

test("11. Cart response identifies changed prices without leaking procurement", async () => {
  const aggregate = await createAggregate({ price: 100, inStock: 4 });
  await postCart(aggregate);
  await Variant.updateOne({ _id: aggregate.variant._id }, { $set: { price: 150 } });
  const response = await request(app).get("/api/cart").set(auth());
  assert.equal(response.status, 200);
  const item = response.body.data.items[0];
  assert.equal(item.priceAtAdd, 100);
  assert.equal(item.currentPrice, 150);
  assert.equal(item.priceChanged, true);
  assert.equal(item.availability, "low_stock");
  for (const forbidden of ["inStock", "sourcing", "supplier", "costPrice"]) {
    assert.equal(JSON.stringify(item).includes(forbidden), false);
  }
});

test("12. Legacy lines require price confirmation", async () => {
  const aggregate = await createAggregate();
  await seedCart(userId(), [{
    productId: aggregate.product._id,
    variantSku: aggregate.variant.sku,
    quantity: 1,
  }]);
  const response = await postCheckout("legacy-price-key");
  assert.equal(response.status, 409);
  assert.equal(response.body.errors[0].type, "price_confirmation_required");
  assert.equal(await Order.countDocuments(), 0);
});

const seedAllConflictCart = async (id) => {
  const missingProductVariant = await createAggregate();
  const missingVariantProduct = await createAggregate();
  const inactive = await createAggregate({ status: PRODUCT_STATUS.ARCHIVED });
  const ownershipProduct = await createAggregate();
  const ownershipVariant = await createAggregate();
  const sourcing = await createAggregate({ sourcing: true });
  const legacy = await createAggregate();
  const changed = await createAggregate({ price: 200 });
  const invalidQuantity = await createAggregate();
  const invalidStock = await createAggregate();
  const insufficient = await createAggregate({ inStock: 1 });
  const missingProductId = new mongoose.Types.ObjectId();

  await Variant.collection.updateOne(
    { _id: invalidStock.variant._id },
    { $set: { inStock: -1 } },
  );

  await seedCart(id, [
    cartLine(missingProductVariant, { productId: missingProductId }),
    cartLine(missingVariantProduct, { variantSku: "MISSING-SKU" }),
    cartLine(inactive),
    cartLine(ownershipVariant, { productId: ownershipProduct.product._id }),
    cartLine(sourcing),
    { productId: legacy.product._id, variantSku: legacy.variant.sku, quantity: 1 },
    cartLine(changed, { priceAtAdd: 100 }),
    cartLine(invalidQuantity, { quantity: 0 }),
    cartLine(invalidStock),
    cartLine(insufficient, { quantity: 2 }),
  ]);

  return { invalidStock, insufficient };
};

test("13. Checkout returns every applicable preflight conflict", async () => {
  await seedAllConflictCart(userId());
  const response = await postCheckout("all-conflicts-key");
  assert.equal(response.status, 409, JSON.stringify(response.body));
  const types = new Set(response.body.errors.map(({ type }) => type));
  for (const required of [
    "product_missing",
    "variant_missing",
    "product_inactive",
    "ownership_mismatch",
    "sourcing_unavailable",
    "price_confirmation_required",
    "price_changed",
    "invalid_quantity",
    "invalid_stock",
    "insufficient_stock",
  ]) assert.ok(types.has(required), `missing conflict ${required}`);
});

test("14. Preflight conflict produces zero inventory, ledger, order or cart mutations", async () => {
  const aggregate = await createAggregate({ inStock: 1 });
  await seedCart(userId(), [cartLine(aggregate, { quantity: 2 })]);
  const beforeCart = await Cart.findOne({ userId: userId() }).lean();
  const response = await postCheckout("zero-mutation-key");
  assert.equal(response.status, 409);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 1);
  assert.equal(await StockLedger.countDocuments(), 0);
  assert.equal(await Order.countDocuments(), 0);
  const afterCart = await Cart.findOne({ userId: userId() }).lean();
  assert.deepEqual(afterCart.items, beforeCart.items);
});

test("15. Successful checkout creates one order, ledger and clears cart", async () => {
  const aggregate = await createAggregate({ inStock: 3, price: 250 });
  await postCart(aggregate, 2);
  const response = await postCheckout("successful-checkout-key");
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await StockLedger.countDocuments(), 1);
  assert.equal(await Cart.countDocuments(), 0);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 1);

  const ledgerEntry = await StockLedger.findOne();
  const persistedDelta = ledgerEntry.delta;
  ledgerEntry.delta = persistedDelta - 1;
  await assert.rejects(
    () => ledgerEntry.save(),
    /StockLedger entries are append-only\. Updates are not allowed\./,
  );
  assert.equal((await StockLedger.findById(ledgerEntry._id)).delta, persistedDelta);
});

test("16. Sequential idempotent retry returns the same order without another decrement", async () => {
  const aggregate = await createAggregate({ inStock: 3 });
  await postCart(aggregate);
  const first = await postCheckout("sequential-replay-key");
  const replayBody = checkoutBody({
    shippingAddress: { street: "  1   Test Street ", country: "ng" },
  });
  const second = await postCheckout("sequential-replay-key", userId(), replayBody);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.headers["idempotency-replayed"], "true");
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await StockLedger.countDocuments(), 1);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 2);
});

test("17. Reusing a key with another fingerprint returns 409", async () => {
  const aggregate = await createAggregate({ inStock: 2 });
  await postCart(aggregate);
  assert.equal((await postCheckout("fingerprint-reuse-key")).status, 201);
  const changed = checkoutBody({ shippingAddress: { city: "Abuja" } });
  const response = await postCheckout("fingerprint-reuse-key", userId(), changed);
  assert.equal(response.status, 409);
  assert.equal(response.body.errors[0].type, "idempotency_key_reused");
  assert.equal(await Order.countDocuments(), 1);
});

test("18. Concurrent identical requests create exactly one order", async () => {
  const aggregate = await createAggregate({ inStock: 2 });
  await postCart(aggregate);
  const [left, right] = await Promise.all([
    postCheckout("concurrent-identical-key"),
    postCheckout("concurrent-identical-key"),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201],
    JSON.stringify([left.body, right.body]));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await StockLedger.countDocuments(), 1);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 1);
});

test("19. Competing checkouts cannot oversell the final unit", async () => {
  const aggregate = await createAggregate({ inStock: 1 });
  const firstUser = userId(11);
  const secondUser = userId(12);
  await seedCart(firstUser, [cartLine(aggregate)]);
  await seedCart(secondUser, [cartLine(aggregate)]);
  const [left, right] = await Promise.all([
    postCheckout("final-unit-left", firstUser),
    postCheckout("final-unit-right", secondUser),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [201, 409],
    JSON.stringify([left.body, right.body]));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await StockLedger.countDocuments(), 1);
  assert.equal((await Variant.findById(aggregate.variant._id)).inStock, 0);
  assert.equal(await Cart.countDocuments(), 1);
});

test("20. Injected post-reservation failure rolls back and leaves key reusable", async () => {
  const first = await createAggregate({ inStock: 3 });
  const second = await createAggregate({ inStock: 3 });
  await seedCart(userId(), [cartLine(first), cartLine(second)]);
  setCheckoutTestHooks({
    afterReservation: ({ index }) => {
      if (index === 0) throw new Error("Injected rollback verification failure");
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await postCheckout("rollback-reusable-key");
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failed.status, 500);
  assert.equal((await Variant.findById(first.variant._id)).inStock, 3);
  assert.equal((await Variant.findById(second.variant._id)).inStock, 3);
  assert.equal(await StockLedger.countDocuments(), 0);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Cart.findOne({ userId: userId() })).items.length, 2);

  setCheckoutTestHooks({});
  const retry = await postCheckout("rollback-reusable-key");
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(await Order.countDocuments(), 1);
});

test("21. Catalogue regression remains green in its own isolated replica set", () => {
  const childEnv = {
    ...process.env,
    TEST_MONGO_URI: "",
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  assert.equal(
    Object.prototype.hasOwnProperty.call(childEnv, "NODE_TEST_CONTEXT"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(childEnv, "NODE_TEST_WORKER_ID"),
    false,
  );

  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "src/scripts/test-catalogue-contract.js"],
    {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 180000,
    },
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /pass 14/);
  assert.match(output, /fail 0/);
});
