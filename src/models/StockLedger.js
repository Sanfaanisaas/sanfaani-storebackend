import mongoose from "mongoose";
const { Schema } = mongoose;
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

const StockLedgerSchema = new Schema({
  variant: {
    type: Schema.Types.ObjectId,
    ref: "Variant",
    required: true,
    index: true,
  },
  delta: {
    type: Number,
    required: true,
  },
  reason: {
    type: String,
    required: true,
    enum: Object.values(STOCK_MOVEMENT_REASON),
  },
  actor: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  resultingStock: {
    type: Number,
    required: true,
  },
}, { timestamps: true });

// Prevent updates or deletes
StockLedgerSchema.pre('save', function(next) {
  if (!this.isNew) {
    return next(new Error('StockLedger entries are append-only. Updates are not allowed.'));
  }
  next();
});

export default mongoose.model("StockLedger", StockLedgerSchema);
