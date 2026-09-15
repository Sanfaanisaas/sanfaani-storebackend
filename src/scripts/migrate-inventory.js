import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Variant from "../models/Variant.js";
import StockLedger from "../models/StockLedger.js";
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryMigrationRun from "../models/InventoryMigrationRun.js";
import { writeAuditLog } from "../services/auditService.js";
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

const duplicateSerialReport = async (session) => {
  const rows = await InventoryUnit.aggregate([
    { $match: { serialNumber: { $type: "string" } } },
    { $group: { _id: { $toUpper: "$serialNumber" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]).session(session || null);
  return rows.map((row) => ({ serial: row._id, count: row.count }));
};

export const reconstructStock = async ({ session } = {}) => {
  const variants = await Variant.find({ sourcing: null }).select("inStock sku").session(session || null).lean();
  const totals = await StockLedger.aggregate([
    { $group: { _id: "$variant", ledgerTotal: { $sum: "$delta" }, entries: { $sum: 1 } } },
  ]).session(session || null);
  const byVariant = new Map(totals.map((row) => [String(row._id), row]));
  const records = variants.map((variant) => {
    const ledger = byVariant.get(String(variant._id));
    const ledgerTotal = ledger?.ledgerTotal || 0;
    return {
      variantId: String(variant._id),
      sku: variant.sku,
      storedStock: variant.inStock,
      reconstructedStock: ledgerTotal,
      ledgerEntries: ledger?.entries || 0,
      matches: ledgerTotal === variant.inStock,
    };
  });
  return {
    records,
    matched: records.filter((record) => record.matches).length,
    mismatched: records.filter((record) => !record.matches).length,
  };
};

const planOpeningBalances = async (session) => {
  const variants = await Variant.find({ sourcing: null }).select("inStock sku").session(session || null).lean();
  const totals = await StockLedger.aggregate([
    { $group: { _id: "$variant", ledgerTotal: { $sum: "$delta" } } },
  ]).session(session || null);
  const byVariant = new Map(totals.map((row) => [String(row._id), row.ledgerTotal]));
  return variants.flatMap((variant) => {
    const ledgerTotal = byVariant.get(String(variant._id)) || 0;
    const openingDelta = variant.inStock - ledgerTotal;
    return openingDelta === 0 ? [] : [{ variant, openingDelta }];
  });
};

export async function runInventoryMigration(options = { apply: false }) {
  const apply = Boolean(options.apply);
  const duplicates = await duplicateSerialReport();
  const plan = await planOpeningBalances();
  const inspectedCount = await Variant.countDocuments({ sourcing: null });
  const dryRun = {
    apply: false,
    inspectedCount,
    openingEntriesPlanned: plan.length,
    openingEntriesCreated: 0,
    duplicatesFound: duplicates.length,
    unresolvedRecords: duplicates.reduce((sum, item) => sum + item.count, 0),
    duplicates,
    success: duplicates.length === 0,
  };
  if (!apply) return dryRun;

  if (!mongoose.isObjectIdOrHexString(options.approvedBy))
    throw new Error("--approved-by with a valid user identifier is required for apply");
  if (!String(options.backupReference || "").trim())
    throw new Error("--backup-reference is required for apply");
  if (!String(options.rollbackReference || "").trim())
    throw new Error("--rollback-reference is required for apply");
  if (duplicates.length) throw new Error("Duplicate serialized units must be resolved before apply");

  const session = await mongoose.startSession();
  try {
    let report;
    await session.withTransaction(async () => {
      const currentPlan = await planOpeningBalances(session);
      const runId = new mongoose.Types.ObjectId();
      for (const { variant, openingDelta } of currentPlan) {
        const [ledger] = await StockLedger.create([{
          variant: variant._id,
          delta: openingDelta,
          reason: STOCK_MOVEMENT_REASON.OPENING_BALANCE_MIGRATION,
          actor: options.approvedBy,
          resultingStock: variant.inStock,
          sourceType: "Migration",
          sourceId: runId,
          idempotencyKey: `inventory-opening:${variant._id}`,
          note: "approved_opening_balance",
        }], { session });
        await writeAuditLog(
          options.approvedBy,
          "STOCK_MOVEMENT_RECORDED",
          "StockLedger",
          ledger._id,
          { delta: openingDelta, reason: ledger.reason, resultingStock: variant.inStock, sourceType: "Migration" },
          session,
        );
      }
      const reconstruction = await reconstructStock({ session });
      if (reconstruction.mismatched !== 0)
        throw new Error("Stock reconstruction failed after opening-balance apply");
      const [run] = await InventoryMigrationRun.create([{
        _id: runId,
        mode: "APPLY",
        approvedBy: options.approvedBy,
        backupReference: options.backupReference,
        rollbackReference: options.rollbackReference,
        inspectedCount,
        openingEntriesCreated: currentPlan.length,
        duplicatesFound: 0,
        reconstructionMatched: reconstruction.matched,
        reconstructionMismatched: reconstruction.mismatched,
        completedAt: new Date(),
      }], { session });
      await writeAuditLog(
        options.approvedBy,
        "INVENTORY_MIGRATION_APPLIED",
        "InventoryMigrationRun",
        run._id,
        { inspectedCount, openingEntriesCreated: currentPlan.length, reconstructionMismatched: reconstruction.mismatched },
        session,
      );
      report = {
        apply: true,
        runId: String(run._id),
        inspectedCount,
        openingEntriesPlanned: currentPlan.length,
        openingEntriesCreated: currentPlan.length,
        duplicatesFound: 0,
        unresolvedRecords: 0,
        reconstructionMatched: reconstruction.matched,
        reconstructionMismatched: reconstruction.mismatched,
        backupReference: options.backupReference,
        rollbackReference: options.rollbackReference,
        success: true,
      };
    });
    return report;
  } finally {
    await session.endSession();
  }
}

const flagValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (process.argv[1] && process.argv[1].endsWith("migrate-inventory.js")) {
  const apply = process.argv.includes("--apply");
  connectDB()
    .then(() => runInventoryMigration({
      apply,
      approvedBy: flagValue("--approved-by"),
      backupReference: flagValue("--backup-reference"),
      rollbackReference: flagValue("--rollback-reference"),
    }))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.success ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
