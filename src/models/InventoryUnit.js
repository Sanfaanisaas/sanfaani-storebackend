import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Variant",
      required: true,
      index: true,
    },
    serialNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 128,
      default: null,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryLocation",
      required: true,
      index: true,
    },
    condition: {
      type: String,
      enum: ["NEW", "REFURBISHED", "USED", "DAMAGED"],
      required: true,
    },
    inspectionState: {
      type: String,
      enum: ["PENDING", "PASSED", "FAILED"],
      default: "PENDING",
    },
    state: {
      type: String,
      enum: [
        "SELLABLE",
        "RESERVED",
        "ALLOCATED",
        "QUARANTINED",
        "RETURNED",
        "CONSUMED",
      ],
      default: "QUARANTINED",
      index: true,
    },
    sourceReference: { type: String, maxlength: 128, default: null },
    lastMovementAt: { type: Date, default: null },
    lastMovementBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);
schema.index(
  { serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { serialNumber: { $type: "string" } },
    name: "unique_inventory_unit_serial",
  },
);
schema.index({ location: 1, variant: 1, state: 1 }, { name: "inventory_unit_location_variant_state" });
export default mongoose.model("InventoryUnit", schema);
