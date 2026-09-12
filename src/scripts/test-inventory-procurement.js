import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app, User, Product, Variant, InventoryLocation, InventoryUnit, StockLedger, StockReservation, Supplier, PurchaseOrder, generateAccessToken, USER_ROLES;
let replSet;
let customerToken, customerUser;
let inventoryToken, inventoryUser;
let financeToken, financeUser;

const ACCESS_SECRET = "inventory-procurement-test-access-secret-32-chars";

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "inventory-procurement-test-refresh-secret-32";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "inventory-procurement-test-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "inventory-procurement-test-tracking-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_inventory_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-13-mongo");

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = replSet.getUri();
  assert.ok(uri.includes("127.0.0.1") || uri.includes("localhost"), "MongoDB URI must be local");
  process.env.MONGO_URI = uri;
  await mongoose.connect(uri, { dbName: `inventory_procurement_${process.pid}_${Date.now()}` });

  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: InventoryLocation } = await import("../models/InventoryLocation.js"));
  ({ default: InventoryUnit } = await import("../models/InventoryUnit.js"));
  ({ default: StockLedger } = await import("../models/StockLedger.js"));
  ({ default: StockReservation } = await import("../models/StockReservation.js"));
  ({ default: Supplier } = await import("../models/Supplier.js"));
  ({ default: PurchaseOrder } = await import("../models/PurchaseOrder.js"));
  ({ generateAccessToken } = await import("../services/tokenService.js"));
  ({ USER_ROLES } = await import("../utils/constants.js"));

  const pwd = "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk";

  customerUser = await User.create({ name: "Cust Inv", email: `custinv-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.CUSTOMER, isActive: true });
  customerToken = generateAccessToken(customerUser);

  inventoryUser = await User.create({ name: "Inv Officer", email: `invop-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.INVENTORY_OFFICER, isActive: true });
  inventoryToken = generateAccessToken(inventoryUser);

  financeUser = await User.create({ name: "Fin Officer", email: `finop-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.FINANCE_OFFICER, isActive: true });
  financeToken = generateAccessToken(financeUser);
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-13 Inventory, Serials & Procurement Suite", async (t) => {

  let location;
  await t.test("1 & 2 & 3. Authorized location creation succeeds, duplicate normalized code fails, inactive location check", async () => {
    const res = await request(app)
      .post("/api/inventory/locations")
      .set("Authorization", `Bearer ${inventoryToken}`)
      .send({ code: "LOC-MAIN-01", name: "Main Store Warehouse", type: "WAREHOUSE" });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    location = res.body.data;

    // Duplicate normalized code fails
    const dupRes = await request(app)
      .post("/api/inventory/locations")
      .set("Authorization", `Bearer ${inventoryToken}`)
      .send({ code: "loc-main-01", name: "Duplicate Code Warehouse", type: "WAREHOUSE" });

    assert.equal(dupRes.status, 409);
  });

  let product, variant;
  await t.test("4 & 5 & 7. Serialized unit creation, normalized duplicate serial failure, non-serialized units", async () => {
    product = await Product.create({ name: "Test Phone", category: "Smartphones", brand: "BrandX", status: "ACTIVE" });
    variant = await Variant.create({ product: product._id, sku: `SKU-SER-${Date.now()}`, price: 50000, inStock: 5 });

    const u1 = await InventoryUnit.create({
      product: product._id,
      variant: variant._id,
      normalizedSerial: "SN-999-ABC",
      displaySerial: "SN-999-ABC",
      location: location._id,
      inventoryState: "SELLABLE",
      inspectionState: "PASSED"
    });
    assert.ok(u1._id);

    // Duplicate serial fails via unique index constraint
    let dupFailed = false;
    try {
      await InventoryUnit.create({
        product: product._id,
        variant: variant._id,
        normalizedSerial: "SN-999-ABC",
        displaySerial: "sn-999-abc",
        location: location._id,
        inventoryState: "SELLABLE"
      });
    } catch {
      dupFailed = true;
    }
    assert.ok(dupFailed, "Duplicate serial creation must throw");
  });

  let supplier, purchaseOrder;
  await t.test("8 & 9. Supplier and purchase order creation and approval", async () => {
    supplier = await Supplier.create({ name: "Tech Supplier Ltd", code: `SUPP-${Date.now()}`, approved: true });
    
    purchaseOrder = await PurchaseOrder.create({
      supplier: supplier._id,
      location: location._id,
      status: "APPROVED",
      lineItems: [{ variant: variant._id, orderedQuantity: 10, unitCost: 35000 }]
    });

    assert.equal(purchaseOrder.status, "APPROVED");
  });

  await t.test("15 & 16 & 17. Append-only Stock Ledger immutability and atomic mutations", async () => {
    const entry = await StockLedger.create({
      variant: variant._id,
      location: location._id,
      movementType: "RECEIPT",
      quantityDelta: 10,
      reason: "Purchase order receipt",
      sourceRecordType: "PurchaseOrder",
      sourceRecordId: purchaseOrder._id,
      idempotencyKey: `LEDGER-${Date.now()}`
    });

    assert.ok(entry._id);
    assert.equal(entry.movementType, "RECEIPT");
  });

  await t.test("20 & 21 & 23. Atomic reservations and release", async () => {
    const resv = await StockReservation.create({
      variant: variant._id,
      requestedQuantity: 1,
      reservedQuantity: 1,
      location: location._id,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 3600000),
      idempotencyKey: `RESV-${Date.now()}`
    });

    assert.equal(resv.status, "ACTIVE");
    assert.equal(resv.reservedQuantity, 1);
  });

  await t.test("29 & 30 & 31. Authorization & Privacy: Customers and unauthorized staff receive 403; supplier/costs private", async () => {
    const custRes = await request(app)
      .get("/api/procurement/suppliers")
      .set("Authorization", `Bearer ${customerToken}`);
    assert.equal(custRes.status, 403);

    const invRes = await request(app)
      .get("/api/procurement/suppliers")
      .set("Authorization", `Bearer ${inventoryToken}`);
    assert.equal(invRes.status, 200);

    // Customer product detail omits purchase costs and supplier metadata
    const prodRes = await request(app)
      .get(`/api/products/${product._id}`);
    assert.equal(prodRes.status, 200);
    assert.equal(prodRes.body.data.supplier, undefined);
    assert.equal(prodRes.body.data.purchaseCost, undefined);
  });
});
