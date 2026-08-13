import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";
import { CatalogueMigrator } from "../../scripts/migrate-catalogue.mjs";
import Cart from "../models/Cart.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import StockLedger from "../models/StockLedger.js";
import Variant from "../models/Variant.js";
import { recordStockMovement } from "../services/inventoryService.js";
import {
  AVAILABILITY_STATUS,
  PRODUCT_CONDITION,
  PRODUCT_STATUS,
  STOCK_MOVEMENT_REASON,
  WARRANTY_TERMS_VERSION,
} from "../utils/constants.js";
import { projectVariantPublic } from "../utils/projections.js";

let app;
let adminToken;
let memoryReplicaSet;
const databaseName = `catalogue_contract_${process.pid}_${Date.now()}`;
const silentLogger = { log() {}, warn() {}, error() {} };

const adminUser = {
  _id: new mongoose.Types.ObjectId(),
  role: "super_admin",
};

const auth = () => ({ Authorization: adminToken });

const completeProductBody = (slug, overrides = {}) => ({
  name: `Product ${slug}`,
  slug,
  description: "A fully described catalogue product",
  category: "Phones",
  brand: "Sanfaani",
  images: ["https://example.test/product.jpg"],
  status: PRODUCT_STATUS.DRAFT,
  ...overrides,
});

const completeVariantBody = (product, sku, overrides = {}) => ({
  product: product.toString(),
  sku,
  attributes: { colour: "Black" },
  price: 125000,
  condition: PRODUCT_CONDITION.REFURBISHED_GRADE_A,
  inspection: {
    summary: "All documented checks passed",
    inspectedAt: "2026-08-10T10:00:00.000Z",
  },
  limitations: "None",
  conditionEvidence: [{
    url: "https://example.test/evidence.jpg",
    alt: "Front and rear condition",
  }],
  warranty: {
    version: WARRANTY_TERMS_VERSION,
    terms: "Ninety-day limited repair warranty",
  },
  inStock: 10,
  ...overrides,
});

const postProduct = async (body) => request(app)
  .post("/api/products")
  .set(auth())
  .send(body);

const postVariant = async (body) => request(app)
  .post("/api/products/variants")
  .set(auth())
  .send(body);

const createAggregate = async ({
  slug,
  sku,
  variantOverrides = {},
  publish = true,
}) => {
  const productResponse = await postProduct(completeProductBody(slug));
  assert.equal(productResponse.status, 201, JSON.stringify(productResponse.body));
  const productId = productResponse.body.data._id;
  const variantResponse = await postVariant(
    completeVariantBody(productId, sku, variantOverrides),
  );
  assert.equal(variantResponse.status, 201, JSON.stringify(variantResponse.body));

  if (publish) {
    const publicationResponse = await request(app)
      .patch(`/api/products/${productId}`)
      .set(auth())
      .send({ status: PRODUCT_STATUS.ACTIVE });
    assert.equal(publicationResponse.status, 200, JSON.stringify(publicationResponse.body));
  }

  return {
    productId,
    variantId: variantResponse.body.data.id,
    sku,
  };
};

const checkoutBody = {
  shippingAddress: {
    street: "1 Test Street",
    city: "Lagos",
    state: "Lagos",
    postalCode: "100001",
    country: "NG",
  },
  paymentMethod: "paystack",
};

const forbiddenKeys = (value, forbidden, path = "data") => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenKeys(item, forbidden, `${path}.${index}`));
  }
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(forbidden.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenKeys(nested, forbidden, `${path}.${key}`),
  ]);
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "catalogue-test-access-secret-at-least-32-chars";
  process.env.JWT_REFRESH_SECRET = "catalogue-test-refresh-secret-at-least-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "catalogue-test-audit-hmac-secret-at-least-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_catalogue_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";

  let mongoUri = process.env.TEST_MONGO_URI;
  if (!mongoUri) {
    process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-mongodb-binaries");
    memoryReplicaSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    mongoUri = memoryReplicaSet.getUri();
  }

  process.env.MONGO_URI = mongoUri;
  await mongoose.connect(mongoUri, { dbName: databaseName });
  ({ default: app } = await import("../app.js"));
  const { generateAccessToken } = await import("../services/tokenService.js");
  adminToken = `Bearer ${generateAccessToken(adminUser)}`;
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (memoryReplicaSet) await memoryReplicaSet.stop();
});

test("1. Draft creation succeeds", async () => {
  const response = await postProduct(completeProductBody("draft-product"));

  assert.equal(response.status, 201);
  assert.equal(response.body.data.status, PRODUCT_STATUS.DRAFT);
  assert.equal(await Product.countDocuments(), 1);
});

test("2. Direct incomplete publication returns structured 422", async () => {
  const response = await postProduct({ status: PRODUCT_STATUS.ACTIVE });

  assert.equal(response.status, 422);
  assert.equal(response.body.success, false);
  assert.ok(Array.isArray(response.body.errors));
  assert.ok(response.body.errors.every((error) => (
    typeof error.code === "string"
      && typeof error.path === "string"
      && typeof error.message === "string"
  )));
  assert.ok(response.body.errors.some(({ code }) => code === "product.variants.required"));
  assert.equal(await Product.countDocuments(), 0);
});

test("3. Complete draft, variant creation and publication succeed", async () => {
  const aggregate = await createAggregate({ slug: "publishable", sku: "PUB-001" });
  const product = await Product.findById(aggregate.productId);
  const variant = await Variant.findById(aggregate.variantId);

  assert.equal(product.status, PRODUCT_STATUS.ACTIVE);
  assert.equal(variant.warranty.version, WARRANTY_TERMS_VERSION);
  assert.equal(variant.inspection.summary, "All documented checks passed");
});

test("4. List and detail use the same public contract", async () => {
  await createAggregate({ slug: "same-contract", sku: "SAME-001" });

  const [listResponse, detailResponse] = await Promise.all([
    request(app).get("/api/products"),
    request(app).get("/api/products/same-contract"),
  ]);
  const listed = listResponse.body.data.products.find(
    (product) => product.slug === "same-contract",
  );

  assert.equal(listResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(listed, detailResponse.body.data);
  assert.equal(listed.status, undefined);
  assert.equal(listed.__v, undefined);
});

test("5. Draft and archived products remain private", async () => {
  await postProduct(completeProductBody("private-draft"));
  await postProduct(completeProductBody("private-archived", {
    status: PRODUCT_STATUS.ARCHIVED,
  }));

  const listResponse = await request(app).get("/api/products");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.body.data.products, []);
  assert.equal((await request(app).get("/api/products/private-draft")).status, 404);
  assert.equal((await request(app).get("/api/products/private-archived")).status, 404);
});

test("6. Procurement fields never appear in serialized API JSON", async () => {
  await createAggregate({
    slug: "private-procurement",
    sku: "SOURCE-001",
    variantOverrides: {
      attributes: {
        colour: "Black",
        supplier: "Must not leak from mixed attributes",
        costPrice: 1,
      },
      inStock: undefined,
      sourcing: {
        supplier: "Internal Supplier",
        leadTimeDays: 7,
        costPrice: 80000,
      },
    },
  });

  const [listResponse, detailResponse] = await Promise.all([
    request(app).get("/api/products"),
    request(app).get("/api/products/private-procurement"),
  ]);
  const forbidden = new Set([
    "sourcing",
    "supplier",
    "costPrice",
    "inStock",
    "status",
    "__v",
    "isActive",
  ]);

  assert.deepEqual(forbiddenKeys(listResponse.body.data.products, forbidden), []);
  assert.deepEqual(forbiddenKeys(detailResponse.body.data, forbidden), []);
});

test("7. Sourcing variants report sourcing", async () => {
  await createAggregate({
    slug: "sourced-device",
    sku: "SOURCE-STATUS",
    variantOverrides: {
      inStock: undefined,
      sourcing: {
        supplier: "Hidden Supplier",
        leadTimeDays: 4,
        costPrice: 90000,
      },
    },
  });

  const response = await request(app).get("/api/products/sourced-device");
  assert.equal(
    response.body.data.variants[0].availability,
    AVAILABILITY_STATUS.SOURCING,
  );
  assert.equal(
    projectVariantPublic({ sku: "INVALID-STOCK", inStock: Number.NaN }).availability,
    AVAILABILITY_STATUS.OUT_OF_STOCK,
  );
  assert.equal(
    projectVariantPublic({ sku: "MISSING-STOCK" }).availability,
    AVAILABILITY_STATUS.OUT_OF_STOCK,
  );
});

test("8. Sourcing variants cannot pass cart, checkout or stock reservation", async () => {
  const aggregate = await createAggregate({
    slug: "not-local-stock",
    sku: "SOURCE-BLOCKED",
    variantOverrides: {
      inStock: undefined,
      sourcing: {
        supplier: "Hidden Supplier",
        leadTimeDays: 3,
        costPrice: 70000,
      },
    },
  });

  const cartResponse = await request(app)
    .post("/api/cart/items")
    .set(auth())
    .send({
      productId: aggregate.productId,
      variantSku: aggregate.sku,
      quantity: 1,
    });
  assert.equal(cartResponse.status, 409);
  assert.equal(cartResponse.body.success, false);
  assert.equal(typeof cartResponse.body.message, "string");
  assert.ok(Array.isArray(cartResponse.body.errors));
  assert.ok(cartResponse.body.errors.some(
    (error) => (error.type ?? error.code) === "sourcing_unavailable",
  ));

  await Cart.create({
    userId: adminUser._id,
    items: [{
      productId: aggregate.productId,
      variantSku: aggregate.sku,
      quantity: 1,
      priceAtAdd: 70000,
    }],
  });
  const checkoutResponse = await request(app)
    .post("/api/checkout")
    .set(auth())
    .set("Idempotency-Key", "catalogue-sourcing-conflict")
    .send(checkoutBody);
  assert.equal(checkoutResponse.status, 409);
  assert.equal(checkoutResponse.body.success, false);
  assert.equal(typeof checkoutResponse.body.message, "string");
  assert.ok(Array.isArray(checkoutResponse.body.errors));
  assert.ok(checkoutResponse.body.errors.some(
    (error) => (error.type ?? error.code) === "sourcing_unavailable",
  ));
  assert.equal(await Order.countDocuments(), 0);

  const session = await mongoose.startSession();
  try {
    await assert.rejects(
      recordStockMovement(
        aggregate.variantId,
        -1,
        STOCK_MOVEMENT_REASON.SALE,
        adminUser._id,
        session,
      ),
      /sourcing-only/,
    );
  } finally {
    await session.endSession();
  }
  assert.equal(await StockLedger.countDocuments(), 0);
});

test("9. Product/variant ownership mismatch is rejected", async () => {
  const first = await createAggregate({ slug: "owner-one", sku: "OWNER-ONE" });
  const second = await createAggregate({ slug: "owner-two", sku: "OWNER-TWO" });

  const cartResponse = await request(app)
    .post("/api/cart/items")
    .set(auth())
    .send({
      productId: second.productId,
      variantSku: first.sku,
      quantity: 1,
    });
  assert.equal(cartResponse.status, 409);
  assert.equal(cartResponse.body.success, false);
  assert.equal(typeof cartResponse.body.message, "string");
  assert.ok(Array.isArray(cartResponse.body.errors));
  assert.ok(cartResponse.body.errors.some(
    (error) => (error.type ?? error.code) === "ownership_mismatch",
  ));

  await Cart.create({
    userId: adminUser._id,
    items: [{
      productId: second.productId,
      variantSku: first.sku,
      quantity: 1,
      priceAtAdd: 10,
    }],
  });
  const checkoutResponse = await request(app)
    .post("/api/checkout")
    .set(auth())
    .set("Idempotency-Key", "catalogue-ownership-conflict")
    .send(checkoutBody);
  assert.equal(checkoutResponse.status, 409);
  assert.equal(checkoutResponse.body.success, false);
  assert.equal(typeof checkoutResponse.body.message, "string");
  assert.ok(Array.isArray(checkoutResponse.body.errors));
  assert.ok(checkoutResponse.body.errors.some(
    (error) => (error.type ?? error.code) === "ownership_mismatch",
  ));
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await StockLedger.countDocuments(), 0);
  assert.equal((await Variant.findById(first.variantId)).inStock, 10);
});

test("10. Duplicate slug and SKU return controlled responses", async () => {
  const aggregate = await createAggregate({
    slug: "unique-values",
    sku: "UNIQUE-SKU",
    publish: false,
  });
  const duplicateSlug = await postProduct(completeProductBody("unique-values"));

  assert.equal(duplicateSlug.status, 409);
  assert.deepEqual(duplicateSlug.body.errors, [{
    field: "slug",
    code: "duplicate",
    message: "slug must be unique",
  }]);
  assert.equal(JSON.stringify(duplicateSlug.body).includes("E11000"), false);

  const duplicateSku = await postVariant(
    completeVariantBody(aggregate.productId, "UNIQUE-SKU"),
  );
  assert.equal(duplicateSku.status, 409);
  assert.equal(duplicateSku.body.errors[0].field, "sku");
  assert.equal(JSON.stringify(duplicateSku.body).includes("E11000"), false);
});

test("11. Migration dry-run performs zero writes", async () => {
  const inserted = await Product.collection.insertOne({
    name: "Legacy Dry Run",
    description: "Legacy description",
    category: "Phones",
    isActive: true,
  });
  const before = await Product.collection.findOne({ _id: inserted.insertedId });
  const migrator = new CatalogueMigrator({ apply: false, logger: silentLogger });
  const stats = await migrator.run();
  const after = await Product.collection.findOne({ _id: inserted.insertedId });

  assert.deepEqual(after, before);
  assert.deepEqual(stats, {
    scanned: 1,
    changed: 1,
    skipped: 0,
    invalid: 1,
    unresolved: 0,
  });
  console.log(`CATALOGUE_MIGRATION_DRY_RUN ${JSON.stringify({ ...stats, writes: 0 })}`);
});

test("12. Apply is deterministic and a second apply changes zero records", async () => {
  const firstId = new mongoose.Types.ObjectId();
  const secondId = new mongoose.Types.ObjectId();
  await Product.collection.insertMany([
    {
      _id: firstId,
      name: "Collision Product",
      slug: "Collision Product",
      description: "Legacy description",
      category: "Phones",
      brand: "Known Brand",
      images: ["https://example.test/legacy.jpg"],
      isActive: true,
    },
    {
      _id: secondId,
      name: "Collision Product",
      slug: "collision-product",
      description: "Legacy description",
      category: "Phones",
      brand: "Known Brand",
      images: ["https://example.test/legacy.jpg"],
      isActive: false,
    },
  ]);

  const firstMigrator = new CatalogueMigrator({ apply: true, logger: silentLogger });
  const firstStats = await firstMigrator.run();
  const firstState = await Product.collection.find({}).sort({ _id: 1 }).toArray();
  const secondMigrator = new CatalogueMigrator({ apply: true, logger: silentLogger });
  const secondStats = await secondMigrator.run();
  const secondState = await Product.collection.find({}).sort({ _id: 1 }).toArray();

  assert.deepEqual(firstStats, {
    scanned: 2,
    changed: 2,
    skipped: 0,
    invalid: 1,
    unresolved: 0,
  });
  assert.deepEqual(secondStats, {
    scanned: 2,
    changed: 0,
    skipped: 2,
    invalid: 0,
    unresolved: 0,
  });
  assert.deepEqual(secondState, firstState);
  assert.notEqual(firstState[0].slug, firstState[1].slug);
  assert.ok(firstState.every((product) => product.status === PRODUCT_STATUS.DRAFT));
  assert.ok(firstState.every((product) => !Object.hasOwn(product, "isActive")));
  console.log(`CATALOGUE_MIGRATION_FIRST_APPLY ${JSON.stringify(firstStats)}`);
  console.log(`CATALOGUE_MIGRATION_SECOND_APPLY ${JSON.stringify(secondStats)}`);
});

test("13. Unambiguous legacy ownership is repaired", async () => {
  const productId = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  await Product.collection.insertOne({
    _id: productId,
    name: "Repairable Ownership",
    slug: "repairable-ownership",
    description: "Complete legacy product",
    category: "Phones",
    brand: "Known Brand",
    images: ["https://example.test/legacy.jpg"],
    isActive: true,
    variants: [variantId],
  });
  await Variant.collection.insertOne({
    _id: variantId,
    sku: "LEGACY-OWNED",
    attributes: { colour: "Black" },
    price: 50000,
    condition: PRODUCT_CONDITION.USED_GRADE_A,
    inspection: { summary: "Legacy inspection is documented" },
    limitations: "Battery health is 90 percent",
    conditionEvidence: [{ url: "https://example.test/legacy-evidence.jpg" }],
    warranty: {
      version: WARRANTY_TERMS_VERSION,
      terms: "Documented legacy warranty",
    },
    inStock: 2,
  });

  const migrator = new CatalogueMigrator({ apply: true, logger: silentLogger });
  const stats = await migrator.run();
  const repairedVariant = await Variant.collection.findOne({ _id: variantId });
  const repairedProduct = await Product.collection.findOne({ _id: productId });

  assert.equal(repairedVariant.product.toString(), productId.toString());
  assert.equal(repairedProduct.status, PRODUCT_STATUS.ACTIVE);
  assert.equal(stats.unresolved, 0);
});

test("14. Duplicate ownership and orphans are reported without deletion or guessing", async () => {
  const firstProductId = new mongoose.Types.ObjectId();
  const secondProductId = new mongoose.Types.ObjectId();
  const sharedVariantId = new mongoose.Types.ObjectId();
  const orphanVariantId = new mongoose.Types.ObjectId();
  const mappedVariantId = new mongoose.Types.ObjectId();
  const missingVariantId = new mongoose.Types.ObjectId();
  await Product.collection.insertMany([
    {
      _id: firstProductId,
      name: "Legacy Owner One",
      slug: "legacy-owner-one",
      description: "Legacy",
      category: "Phones",
      brand: "Known",
      status: PRODUCT_STATUS.DRAFT,
      variants: [sharedVariantId, missingVariantId],
    },
    {
      _id: secondProductId,
      name: "Legacy Owner Two",
      slug: "legacy-owner-two",
      description: "Legacy",
      category: "Phones",
      brand: "Known",
      status: PRODUCT_STATUS.DRAFT,
      variants: [sharedVariantId],
    },
  ]);
  await Variant.collection.insertMany([
    { _id: sharedVariantId, sku: "SHARED-LEGACY" },
    { _id: orphanVariantId, sku: "ORPHAN-LEGACY" },
    { _id: mappedVariantId, sku: "MAPPED-LEGACY" },
  ]);

  const migrator = new CatalogueMigrator({
    apply: true,
    logger: silentLogger,
    orphanMapping: new Map([[mappedVariantId.toString(), firstProductId.toString()]]),
  });
  const stats = await migrator.run();
  const issueTypes = migrator.issues.map(({ type }) => type).sort();

  assert.deepEqual(issueTypes, [
    "duplicate_variant_ownership",
    "missing_variant_reference",
    "orphan_variant",
  ]);
  assert.equal(stats.unresolved, 3);
  assert.equal(await Variant.collection.countDocuments({}), 3);
  assert.equal((await Variant.collection.findOne({ _id: sharedVariantId })).product, undefined);
  assert.equal((await Variant.collection.findOne({ _id: orphanVariantId })).product, undefined);
  assert.equal(
    (await Variant.collection.findOne({ _id: mappedVariantId })).product.toString(),
    firstProductId.toString(),
  );
});
