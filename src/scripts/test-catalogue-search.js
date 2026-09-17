import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app, Product, Variant, PRODUCT_STATUS, PRODUCT_CONDITION;
let replSet;

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be15-mongo");
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `catalogue_search_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));

  // Safely import constants to perfectly match schema requirements
  const constants = await import("../utils/constants.js");
  PRODUCT_STATUS = constants.PRODUCT_STATUS || {};
  PRODUCT_CONDITION = constants.PRODUCT_CONDITION || {};

  await Promise.all([Product.createIndexes(), Variant.createIndexes()]);

  const activeStatus = PRODUCT_STATUS.ACTIVE || "active";
  const draftStatus = PRODUCT_STATUS.DRAFT || "draft";
  const condNew = PRODUCT_CONDITION.NEW || "new";
  const condRefurb =
    PRODUCT_CONDITION.REFURBISHED_GRADE_A || "refurbished_grade_a";

  // Seed Products using the exact schema enums
  const p1 = await Product.create({
    name: "Galaxy S24 Ultra",
    slug: "s24-ultra",
    description: "Flagship smartphone",
    category: "Smartphones",
    brand: "Samsung",
    status: activeStatus,
  });
  const p2 = await Product.create({
    name: "Galaxy S23",
    slug: "s23",
    description: "Older phone",
    category: "Smartphones",
    brand: "Samsung",
    status: activeStatus,
  });
  const p3 = await Product.create({
    name: "MacBook Pro 16",
    slug: "mbp-16",
    description: "Pro Laptop",
    category: "Laptops",
    brand: "Apple",
    status: activeStatus,
  });
  const pDraft = await Product.create({
    name: "Draft Phone",
    slug: "draft",
    description: "Hidden",
    category: "Smartphones",
    brand: "Apple",
    status: draftStatus,
  });

  // Seed Variants using the exact schema enums
  await Variant.create({
    product: p1._id,
    sku: "S24-U-1",
    price: 120000,
    condition: condNew,
    inStock: 10,
    attributes: { storage: "256GB" },
  }); // In Stock
  await Variant.create({
    product: p2._id,
    sku: "S23-1",
    price: 60000,
    condition: condRefurb,
    inStock: 3,
    attributes: { storage: "128GB" },
  }); // Low Stock
  // Removed `inStock: 0` here so it passes the XOR inventoryMode validation
  await Variant.create({
    product: p3._id,
    sku: "MBP-16-1",
    price: 250000,
    condition: condNew,
    sourcing: { supplier: "AppleDirect", leadTimeDays: 7, costPrice: 200000 },
    attributes: { ram: "16GB" },
  });
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-15 Catalogue Search & Discovery", async (t) => {
  await t.test(
    "1. Returns only ACTIVE products, applies privacy projections, and paginates",
    async () => {
      const res = await request(app).get("/api/products");
      assert.equal(res.status, 200);
      assert.equal(
        res.body.data.products.length,
        3,
        "Draft products must be excluded",
      );
      assert.equal(res.body.data.pagination.total, 3);

      const mbp = res.body.data.products.find((p) => p.slug === "mbp-16");
      assert.equal(mbp.variants[0].availability, "sourcing");
      assert.equal(
        mbp.variants[0].supplier,
        undefined,
        "Procurement truth must not leak",
      );
      assert.equal(mbp.variants[0].costPrice, undefined, "Costs must not leak");
    },
  );

  await t.test(
    "2. Text search matches keywords and sorts by relevance",
    async () => {
      const res = await request(app).get("/api/products?q=Galaxy");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.products.length, 2);
    },
  );

  await t.test("3. Filters by Brand and Category", async () => {
    const res = await request(app).get(
      "/api/products?brand=Apple&category=Laptops",
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data.products.length, 1);
    assert.equal(res.body.data.products[0].slug, "mbp-16");
  });

  await t.test(
    "4. Filters by Variant Price Bounds (minPrice/maxPrice)",
    async () => {
      const res = await request(app).get(
        "/api/products?minPrice=50000&maxPrice=100000",
      );
      assert.equal(res.status, 200);
      assert.equal(
        res.body.data.products.length,
        1,
        "Only S23 has a variant in this range",
      );
      assert.equal(res.body.data.products[0].slug, "s23");
    },
  );

  await t.test(
    "5. Validates input schema (minPrice > maxPrice fails)",
    async () => {
      const res = await request(app).get(
        "/api/products?minPrice=100000&maxPrice=50000",
      );
      assert.equal(res.status, 422); // Standard validation error
    },
  );

  await t.test("6. Sorts products deterministically by price", async () => {
    const resAsc = await request(app).get("/api/products?sort=price_asc");
    assert.equal(
      resAsc.body.data.products[0].slug,
      "s23",
      "Lowest price first",
    );

    const resDesc = await request(app).get("/api/products?sort=price_desc");
    assert.equal(
      resDesc.body.data.products[0].slug,
      "mbp-16",
      "Highest price first",
    );
  });

  await t.test("7. Filters by exact Variant Availability status", async () => {
    const resSourcing = await request(app).get(
      "/api/products?availability=sourcing",
    );
    assert.equal(resSourcing.body.data.products.length, 1);
    assert.equal(resSourcing.body.data.products[0].slug, "mbp-16");

    const resLowStock = await request(app).get(
      "/api/products?availability=low_stock",
    );
    assert.equal(resLowStock.body.data.products.length, 1);
    assert.equal(resLowStock.body.data.products[0].slug, "s23");
  });
});
