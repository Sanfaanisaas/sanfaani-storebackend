import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

let replSet;
let User;
let Product;
let Variant;
let StockLedger;
let InventoryMigrationRun;
let runInventoryMigration;
let reconstructStock;
let actor;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "stock-reconstruction-access-secret-32-chars";
  process.env.JWT_REFRESH_SECRET = "stock-reconstruction-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "stock-reconstruction-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "stock-reconstruction-track-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_stock_reconstruction";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be18-mongo");
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be18_reconstruction_${process.pid}_${Date.now()}` });
  ({ default: User } = await import("../models/User.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: StockLedger } = await import("../models/StockLedger.js"));
  ({ default: InventoryMigrationRun } = await import("../models/InventoryMigrationRun.js"));
  ({ runInventoryMigration, reconstructStock } = await import("./migrate-inventory.js"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  actor = await User.create({ name: "Migration Approver", email: `migration-${Date.now()}@example.com`, passwordHash: "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk", role: "super_admin", isActive: true });
  const product = await Product.create({ name: "Migration Product", slug: `migration-product-${Date.now()}`, description: "Migration", category: "Computers", brand: "Sanfaani", status: "active" });
  await Variant.create({ product: product._id, sku: `MIG-${Date.now()}`, attributes: { memory: "16GB" }, price: 200000, condition: "new", inStock: 7 });
});

after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-18 migration and reconstruction evidence", async (t) => {
  await t.test("1. dry-run is read-only and reports the opening-balance plan", async () => {
    const report = await runInventoryMigration({ apply: false });
    assert.equal(report.success, true);
    assert.equal(report.openingEntriesPlanned, 1);
    assert.equal(await StockLedger.countDocuments(), 0);
    assert.equal(await InventoryMigrationRun.countDocuments(), 0);
  });
  await t.test("2. apply is blocked without approval, backup, and rollback evidence", async () => {
    await assert.rejects(runInventoryMigration({ apply: true }), /approved-by/);
    await assert.rejects(runInventoryMigration({ apply: true, approvedBy: actor._id }), /backup-reference/);
    await assert.rejects(runInventoryMigration({ apply: true, approvedBy: actor._id, backupReference: "backup://be18" }), /rollback-reference/);
  });
  await t.test("3. approved apply records one opening fact and exact reconstruction", async () => {
    const report = await runInventoryMigration({ apply: true, approvedBy: actor._id, backupReference: "backup://be18/001", rollbackReference: "runbook://inventory/rollback/001" });
    assert.equal(report.openingEntriesCreated, 1);
    assert.equal(report.reconstructionMismatched, 0);
    assert.equal(await StockLedger.countDocuments({ reason: "opening_balance_migration" }), 1);
    assert.equal(await InventoryMigrationRun.countDocuments(), 1);
    const reconstruction = await reconstructStock();
    assert.equal(reconstruction.mismatched, 0);
  });
  await t.test("4. a second apply is idempotent and adds no opening fact", async () => {
    const report = await runInventoryMigration({ apply: true, approvedBy: actor._id, backupReference: "backup://be18/002", rollbackReference: "runbook://inventory/rollback/002" });
    assert.equal(report.openingEntriesCreated, 0);
    assert.equal(await StockLedger.countDocuments({ reason: "opening_balance_migration" }), 1);
    assert.equal(await InventoryMigrationRun.countDocuments(), 2);
  });
  await t.test("5. immutable migration evidence cannot be updated or deleted", async () => {
    const run = await InventoryMigrationRun.findOne();
    await assert.rejects(InventoryMigrationRun.updateOne({ _id: run._id }, { $set: { backupReference: "changed" } }), /immutable/);
    await assert.rejects(InventoryMigrationRun.deleteOne({ _id: run._id }), /immutable/);
  });
});
