import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let replSet;
let app;
let User;
let Product;
let Variant;
let InventoryLocation;
let InventoryUnit;
let StockLedger;
let StockCount;
let StockDiscrepancy;
let PurchaseOrder;
let Evidence;
let AuditLog;
let tokenFor;
let setAuditServiceTestHooks;
let roles;
let inventoryUser;
let opsUser;
let customerUser;
let inventoryToken;
let opsToken;
let customerToken;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const key = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "inventory-operations-access-secret-32-chars";
  process.env.JWT_REFRESH_SECRET = "inventory-operations-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "inventory-operations-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "inventory-operations-track-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_inventory_operations";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be18-mongo");
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be18_inventory_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: InventoryLocation } = await import("../models/InventoryLocation.js"));
  ({ default: InventoryUnit } = await import("../models/InventoryUnit.js"));
  ({ default: StockLedger } = await import("../models/StockLedger.js"));
  ({ default: StockCount } = await import("../models/StockCount.js"));
  ({ default: StockDiscrepancy } = await import("../models/StockDiscrepancy.js"));
  ({ default: PurchaseOrder } = await import("../models/PurchaseOrder.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ generateAccessToken: tokenFor } = await import("../services/tokenService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  ({ USER_ROLES: roles } = await import("../utils/constants.js"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  const passwordHash = "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk";
  [inventoryUser, opsUser, customerUser] = await User.create([
    { name: "Inventory", email: `inventory-${Date.now()}@example.com`, passwordHash, role: roles.INVENTORY_OFFICER, isActive: true },
    { name: "Operations", email: `operations-${Date.now()}@example.com`, passwordHash, role: roles.OPS_MANAGER, isActive: true },
    { name: "Customer", email: `customer-${Date.now()}@example.com`, passwordHash, role: roles.CUSTOMER, isActive: true },
  ]);
  inventoryToken = tokenFor(inventoryUser);
  opsToken = tokenFor(opsUser);
  customerToken = tokenFor(customerUser);
});

after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-18 inventory and procurement operations", async (t) => {
  let supplier;
  let purchaseOrder;
  let product;
  let variant;
  let locationA;
  let locationB;
  let evidence;

  await t.test("1. customer cannot enumerate private suppliers or inventory operations", async () => {
    const supplierResponse = await request(app).get("/api/procurement/suppliers").set(auth(customerToken));
    const countResponse = await request(app).get("/api/inventory/stock-counts").set(auth(customerToken));
    assert.equal(supplierResponse.status, 403);
    assert.equal(countResponse.status, 403);
  });

  await t.test("2. supplier create/list/update is role-controlled and projected", async () => {
    const denied = await request(app).post("/api/procurement/suppliers").set(auth(inventoryToken)).send({ name: "Denied Supplier" });
    assert.equal(denied.status, 403);
    const created = await request(app).post("/api/procurement/suppliers").set(auth(opsToken)).send({
      name: "BE18 Components",
      email: "supply@example.test",
      phone: "+2348000000000",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(Object.keys(created.body.data).sort(), ["active", "createdAt", "deactivatedAt", "email", "id", "name", "phone", "updatedAt", "version"].sort());
    supplier = created.body.data;
    const updated = await request(app).patch(`/api/procurement/suppliers/${supplier.id}`).set(auth(opsToken)).send({ expectedVersion: supplier.version, phone: "+2348111111111" });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    supplier = updated.body.data;
    const listed = await request(app).get("/api/procurement/suppliers?active=true").set(auth(inventoryToken));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.items.length, 1);
  });

  await t.test("3. purchase order create is payload-idempotent and follows submit/approve", async () => {
    product = await Product.create({ name: "BE18 Phone", slug: key("be18-phone"), description: "Inventory test", category: "Smartphones", brand: "Sanfaani", status: "active" });
    variant = await Variant.create({ product: product._id, sku: key("BE18-SKU").toUpperCase(), attributes: { color: "Black" }, price: 100000, condition: "new", inStock: 2 });
    locationA = await InventoryLocation.create({ name: "BE18 Main", code: key("BE18-A").slice(0, 30).toUpperCase() });
    locationB = await InventoryLocation.create({ name: "BE18 Branch", code: key("BE18-B").slice(0, 30).toUpperCase() });
    const body = { supplier: supplier.id, lines: [{ variant: String(variant._id), quantity: 3, unitCost: 70000 }], idempotencyKey: key("po") };
    const first = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send(body);
    const replay = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 201);
    assert.equal(first.body.data.id, replay.body.data.id);
    assert.equal(await PurchaseOrder.countDocuments({ idempotencyKey: body.idempotencyKey }), 1);
    purchaseOrder = first.body.data;
    const submitted = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/submit`).set(auth(inventoryToken));
    assert.equal(submitted.body.data.status, "PENDING_APPROVAL");
    const deniedApproval = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/approve`).set(auth(inventoryToken));
    assert.equal(deniedApproval.status, 403);
    const approved = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/approve`).set(auth(opsToken));
    assert.equal(approved.body.data.status, "APPROVED");
  });

  await t.test("4. evidence-backed receipt atomically creates stock, ledger, and audit once", async () => {
    evidence = await Evidence.create({
      subjectType: "purchase_order",
      subject: purchaseOrder.id,
      owner: inventoryUser._id,
      purpose: "procurement",
      displayName: "delivery-note.pdf",
      objectKey: key("evidence"),
      checksum: "a".repeat(64),
      detectedMimeType: "application/pdf",
      size: 120,
      uploader: inventoryUser._id,
    });
    const body = { variantId: String(variant._id), quantity: 3, locationId: String(locationA._id), serials: [], condition: "NEW", evidenceId: String(evidence._id), idempotencyKey: key("receipt") };
    const first = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send(body);
    const replay = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal((await Variant.findById(variant._id)).inStock, 5);
    assert.equal(await StockLedger.countDocuments({ idempotencyKey: `receipt:${body.idempotencyKey}` }), 1);
    assert.equal(await AuditLog.countDocuments({ action: "STOCK_MOVEMENT_RECORDED" }), 1);
    assert.equal(first.body.data.status, "CLOSED");
  });

  await t.test("5. over-receipt and invalid state do not create partial stock facts", async () => {
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const response = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send({
      variantId: String(variant._id), quantity: 1, locationId: String(locationA._id), evidenceId: String(evidence._id), idempotencyKey: key("over-receipt"), serials: [], condition: "NEW",
    });
    assert.equal(response.status, 409);
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
  });

  await t.test("6. serialized receipt is quarantined, ledger-recorded, and explicitly closed", async () => {
    const created = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send({
      supplier: supplier.id,
      lines: [{ variant: String(variant._id), quantity: 1, unitCost: 71000 }],
      idempotencyKey: key("po-serial"),
    });
    const serialPoId = created.body.data.id;
    await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/submit`).set(auth(inventoryToken));
    await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/approve`).set(auth(opsToken));
    const serialEvidence = await Evidence.create({
      subjectType: "purchase_order",
      subject: serialPoId,
      owner: inventoryUser._id,
      purpose: "procurement",
      displayName: "serialized-delivery.pdf",
      objectKey: key("serial-evidence"),
      checksum: "b".repeat(64),
      detectedMimeType: "application/pdf",
      size: 121,
      uploader: inventoryUser._id,
    });
    const serialNumber = key("BE18-SERIAL").toUpperCase();
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const received = await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/receipts`).set(auth(inventoryToken)).send({
      variantId: String(variant._id),
      quantity: 1,
      locationId: String(locationA._id),
      serials: [serialNumber],
      condition: "NEW",
      evidenceId: String(serialEvidence._id),
      idempotencyKey: key("serialized-receipt"),
    });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.data.status, "RECEIVING");
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
    const unit = await InventoryUnit.findOne({ serialNumber });
    assert.equal(unit.state, "QUARANTINED");
    assert.equal(await StockLedger.countDocuments({ inventoryUnit: unit._id, delta: 0, reason: "restock" }), 1);
    const closed = await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/close`).set(auth(opsToken)).send({ reason: "All serialized units received into quarantine" });
    assert.equal(closed.body.data.status, "CLOSED");
  });

  await t.test("7. available serialized unit transfers exactly once with a zero-delta ledger fact", async () => {
    const unit = await InventoryUnit.create({ variant: variant._id, serialNumber: key("SERIAL").toUpperCase(), location: locationA._id, condition: "NEW", inspectionState: "PASSED", state: "SELLABLE" });
    const body = { toLocationId: String(locationB._id), reason: "Customer fulfilment relocation", evidenceId: String(evidence._id), idempotencyKey: key("transfer") };
    const first = await request(app).post(`/api/inventory/units/${unit._id}/transfer`).set(auth(inventoryToken)).send(body);
    const replay = await request(app).post(`/api/inventory/units/${unit._id}/transfer`).set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal(first.body.data.ledger.delta, 0);
    assert.equal(String((await InventoryUnit.findById(unit._id)).location), String(locationB._id));
    assert.equal(await StockLedger.countDocuments({ idempotencyKey: body.idempotencyKey }), 1);
  });

  await t.test("8. returned and quarantined serialized units cannot be released twice", async () => {
    for (const [state, endpoint] of [["RETURNED", "return-to-stock"], ["QUARANTINED", "release-quarantine"]]) {
      const unit = await InventoryUnit.create({ variant: variant._id, serialNumber: key(state).toUpperCase(), location: locationA._id, condition: "NEW", inspectionState: "PASSED", state });
      const body = { reason: `${state} inspected and approved`, evidenceId: String(evidence._id), idempotencyKey: key(endpoint) };
      const [first, second] = await Promise.all([
        request(app).post(`/api/inventory/units/${unit._id}/${endpoint}`).set(auth(inventoryToken)).send(body),
        request(app).post(`/api/inventory/units/${unit._id}/${endpoint}`).set(auth(inventoryToken)).send({ ...body, idempotencyKey: key(`${endpoint}-second`) }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    }
  });

  await t.test("9. evidence-backed manual adjustment rejects idempotency payload drift", async () => {
    const body = { variantId: String(variant._id), delta: -1, reason: "damage", note: "Damaged during handling", evidenceId: String(evidence._id), idempotencyKey: key("adjust") };
    const first = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send(body);
    const replay = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send(body);
    const drift = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send({ ...body, delta: -2 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal(drift.status, 409);
  });

  await t.test("10. count creates discrepancy; only governance roles can explicitly reconcile it", async () => {
    const current = (await Variant.findById(variant._id)).inStock;
    const countedQuantity = current - 1;
    const count = await request(app).post("/api/inventory/stock-counts").set(auth(inventoryToken)).send({
      variantId: String(variant._id), locationId: String(locationA._id), countedQuantity, reason: "Scheduled cycle count", evidenceId: String(evidence._id), idempotencyKey: key("count"),
    });
    assert.equal(count.status, 201, JSON.stringify(count.body));
    assert.equal(count.body.data.status, "DISCREPANCY");
    const discrepancyId = count.body.data.discrepancyId;
    const body = { resolution: "ADJUST_STOCK", resolutionReason: "Count verified by operations manager", evidenceId: String(evidence._id), idempotencyKey: key("resolve") };
    const denied = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(inventoryToken)).send(body);
    assert.equal(denied.status, 403);
    const resolved = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(opsToken)).send(body);
    const replay = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(opsToken)).send(body);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.status, "RESOLVED");
    assert.equal(replay.status, 200);
    assert.equal((await Variant.findById(variant._id)).inStock, countedQuantity);
    assert.equal((await StockCount.findById(count.body.data.id)).status, "RECONCILED");
  });

  await t.test("11. required audit failure rolls stock and ledger back together", async () => {
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const beforeLedger = await StockLedger.countDocuments();
    setAuditServiceTestHooks({
      beforeWrite: ({ action }) => {
        if (action === "STOCK_MOVEMENT_RECORDED") throw new Error("forced inventory audit failure");
      },
    });
    try {
      const response = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send({
        variantId: String(variant._id), delta: 1, reason: "adjustment", note: "Rollback assertion", evidenceId: String(evidence._id), idempotencyKey: key("audit-rollback"),
      });
      assert.equal(response.status, 500);
    } finally {
      setAuditServiceTestHooks({});
    }
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
    assert.equal(await StockLedger.countDocuments(), beforeLedger);
  });

  await t.test("12. immutable ledger rejects document, query update, and delete paths", async () => {
    const ledger = await StockLedger.findOne();
    ledger.note = "mutated";
    await assert.rejects(ledger.save(), /append-only/);
    await assert.rejects(StockLedger.updateOne({ _id: ledger._id }, { $set: { note: "mutated" } }), /append-only/);
    await assert.rejects(StockLedger.deleteOne({ _id: ledger._id }), /append-only/);
  });

  await t.test("13. supplier deactivation is blocked by active POs and audited after cancellation", async () => {
    const created = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send({
      supplier: supplier.id, lines: [{ variant: String(variant._id), quantity: 1, unitCost: 50000 }], idempotencyKey: key("po-active"),
    });
    const submitted = await request(app).post(`/api/procurement/purchase-orders/${created.body.data.id}/submit`).set(auth(inventoryToken));
    assert.equal(submitted.status, 200);
    const blocked = await request(app).post(`/api/procurement/suppliers/${supplier.id}/deactivate`).set(auth(opsToken)).send({ expectedVersion: supplier.version, reason: "Contract ended" });
    assert.equal(blocked.status, 409);
    const cancelled = await request(app).post(`/api/procurement/purchase-orders/${created.body.data.id}/cancel`).set(auth(opsToken)).send({ reason: "Supplier contract ended" });
    assert.equal(cancelled.body.data.status, "CANCELLED");
    const deactivated = await request(app).post(`/api/procurement/suppliers/${supplier.id}/deactivate`).set(auth(opsToken)).send({ expectedVersion: supplier.version, reason: "Contract ended" });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.active, false);
    assert.equal(await AuditLog.countDocuments({ action: "SUPPLIER_DEACTIVATED" }), 1);
  });

  await t.test("14. malformed identifiers and bodies use the standard validation envelope", async () => {
    const response = await request(app).post("/api/inventory/units/not-an-id/transfer").set(auth(inventoryToken)).send({});
    assert.equal(response.status, 422);
    assert.equal(response.body.success, false);
    assert.equal(typeof response.body.message, "string");
    assert.ok(Array.isArray(response.body.errors));
  });
});
