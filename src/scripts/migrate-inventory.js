import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Variant from "../models/Variant.js";
import StockLedger from "../models/StockLedger.js";
import InventoryUnit from "../models/InventoryUnit.js";

export async function runInventoryMigration(options = { apply: false }) {
  const apply = Boolean(options.apply);
  console.log(`[INVENTORY MIGRATION] Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (read-only)"}`);

  const variants = await Variant.find({});
  let inspectedCount = 0;
  let openingEntriesPlanned = 0;
  let duplicatesFound = 0;
  let unresolvedRecords = 0;

  // Check duplicate serials in InventoryUnits
  const units = await InventoryUnit.find({}).select("normalizedSerial");
  const serialCounts = new Map();
  for (const u of units) {
    if (u.normalizedSerial) {
      serialCounts.set(u.normalizedSerial, (serialCounts.get(u.normalizedSerial) || 0) + 1);
    }
  }

  for (const [serial, count] of serialCounts.entries()) {
    if (count > 1) {
      duplicatesFound += 1;
      unresolvedRecords += count;
      console.warn(`[WARNING] Duplicate serial detected: ${serial} (count: ${count})`);
    }
  }

  if (duplicatesFound > 0) {
    console.error(`[MIGRATION HALTED] Found ${duplicatesFound} duplicate serials. Resolve manually before applying.`);
    return { apply, inspectedCount: variants.length, openingEntriesPlanned: 0, duplicatesFound, unresolvedRecords, success: false };
  }

  for (const v of variants) {
    inspectedCount += 1;
    if (Number.isFinite(v.inStock) && v.inStock > 0) {
      const existingLedger = await StockLedger.findOne({
        variant: v._id,
        reason: "OPENING_BALANCE_MIGRATION"
      });

      if (!existingLedger) {
        openingEntriesPlanned += 1;
        if (apply) {
          await StockLedger.create({
            variant: v._id,
            movementType: "RECEIPT",
            quantityDelta: v.inStock,
            reason: "OPENING_BALANCE_MIGRATION",
            idempotencyKey: `MIGRATE_OPENING_${v._id.toString()}`
          });
        }
      }
    }
  }

  console.log(`[MIGRATION SUMMARY] Inspected: ${inspectedCount}, Opening Entries Planned/Created: ${openingEntriesPlanned}, Duplicates: ${duplicatesFound}`);
  return { apply, inspectedCount, openingEntriesPlanned, duplicatesFound, unresolvedRecords: 0, success: true };
}

if (process.argv[1] && process.argv[1].endsWith("migrate-inventory.js")) {
  const isApply = process.argv.includes("--apply");
  connectDB().then(() => runInventoryMigration({ apply: isApply })).then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
