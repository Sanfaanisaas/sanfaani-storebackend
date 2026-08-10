import Variant from "../models/Variant.js";
import StockLedger from "../models/StockLedger.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "./auditService.js";
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

export const assertLocalInventory = (variant, requestedQuantity) => {
  if (variant?.sourcing != null) {
    throw new AppError(`Variant ${variant.sku || variant._id} is sourcing-only`, 400);
  }

  if (!Number.isFinite(variant?.inStock) || variant.inStock < 0) {
    throw new AppError(`Variant ${variant?.sku || variant?._id} has invalid local inventory`, 400);
  }

  if (requestedQuantity !== undefined) {
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      throw new AppError("Requested quantity must be a positive integer", 400);
    }
    if (requestedQuantity > variant.inStock) {
      throw new AppError(
        `Insufficient stock for variant ${variant.sku || variant._id}`,
        409,
      );
    }
  }
};

/**
 * Record a stock movement atomically
 */
export const recordStockMovement = async (variantId, delta, reason, actorId, session) => {
  const variant = await Variant.findById(variantId).session(session);
  if (!variant) {
    throw new AppError(`Variant not found for ID: ${variantId}`, 404);
  }

  assertLocalInventory(variant, delta < 0 ? Math.abs(delta) : undefined);

  if (!Number.isFinite(delta) || delta === 0) {
    throw new AppError("Stock movement delta must be a finite non-zero number", 400);
  }

  // Guard against negative stock: handle separately if delta is negative
  const query = {
    _id: variantId,
    sourcing: null,
    inStock: { $type: "number", $gte: 0 },
  };
  if (delta < 0) {
    query.inStock.$gte = Math.abs(delta);
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
