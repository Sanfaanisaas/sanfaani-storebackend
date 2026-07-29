import Variant from "../models/Variant.js";
import StockLedger from "../models/StockLedger.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "./auditService.js";
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

/**
 * Record a stock movement atomically
 */
export const recordStockMovement = async (variantId, delta, reason, actorId, session) => {
  // Guard against negative stock: handle separately if delta is negative
  const query = { _id: variantId };
  if (delta < 0) {
    query.inStock = { $gte: Math.abs(delta) };
  }

  const updatedVariant = await Variant.findOneAndUpdate(
    query,
    { $inc: { inStock: delta } },
    { new: true, session, runValidators: true }
  );

  if (!updatedVariant) {
    throw new AppError(`Insufficient stock or variant not found for ID: ${variantId}`, 409);
  }

  const ledgerEntry = await StockLedger.create([
    {
      variant: variantId,
      delta,
      reason,
      actor: actorId,
      resultingStock: updatedVariant.inStock,
    }
  ], { session });

  // Log manual adjustments to audit log
  if ([STOCK_MOVEMENT_REASON.ADJUSTMENT, STOCK_MOVEMENT_REASON.DAMAGE, STOCK_MOVEMENT_REASON.RESTOCK].includes(reason)) {
    await writeAuditLog(
      actorId,
      'STOCK_ADJUSTED',
      'Variant',
      variantId,
      { delta, reason, resultingStock: updatedVariant.inStock }
    );
  }

  return { variant: updatedVariant, ledger: ledgerEntry[0] };
};
