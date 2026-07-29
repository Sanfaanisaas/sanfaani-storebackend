import * as inventoryService from "../services/inventoryService.js";
import { catchAsync } from "../utils/catchAsync.js";
import mongoose from "mongoose";

export const recordManualStockMovement = catchAsync(async (req, res) => {
  const { variantId, delta, reason } = req.body;
  const actorId = req.user.id;

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      result = await inventoryService.recordStockMovement(
        variantId,
        delta,
        reason,
        actorId,
        session
      );
    });

    res.status(201).json({
      success: true,
      data: result
    });
  } finally {
    await session.endSession();
  }
});
