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
    min: 0,
  },
  inventoryUnit: {
    type: Schema.Types.ObjectId,
    ref: "InventoryUnit",
    default: null,
    index: true,
  },
  fromLocation: {
    type: Schema.Types.ObjectId,
    ref: "InventoryLocation",
    default: null,
  },
  toLocation: {
    type: Schema.Types.ObjectId,
    ref: "InventoryLocation",
    default: null,
  },
  sourceType: {
    type: String,
    enum: ["PurchaseOrder", "StockCount", "StockDiscrepancy", "InventoryUnit", "Order", "Migration", "Manual"],
    default: "Manual",
  },
  sourceId: { type: Schema.Types.ObjectId, default: null, index: true },
  idempotencyKey: { type: String, trim: true, maxlength: 160, default: null },
  requestDigest: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  note: { type: String, trim: true, maxlength: 500, default: null },
}, { timestamps: true });

StockLedgerSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "unique_stock_ledger_idempotency_key",
  },
);

// Prevent updates or deletes
StockLedgerSchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error(
      "StockLedger entries are append-only. Updates are not allowed.",
    );
  }
});

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  StockLedgerSchema.pre(operation, function () {
    throw new Error("StockLedger entries are append-only. Mutation is not allowed.");
  });
}

export default mongoose.model("StockLedger", StockLedgerSchema);
