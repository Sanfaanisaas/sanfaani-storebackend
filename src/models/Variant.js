import mongoose from "mongoose";
import {
  AVAILABILITY_STATUS,
  LOW_STOCK_THRESHOLD,
  PRODUCT_CONDITION,
} from "../utils/constants.js";

const { Schema } = mongoose;

const finiteNonNegative = {
  validator: (value) => Number.isFinite(value) && value >= 0,
  message: "{PATH} must be a finite non-negative number",
};

const SourcingSchema = new Schema(
  {
    supplier: { type: String, required: true, trim: true },
    leadTimeDays: { type: Number, required: true, validate: finiteNonNegative },
    costPrice: { type: Number, required: true, validate: finiteNonNegative },
  },
  { _id: false, strict: "throw" },
);

const WarrantyTermsSchema = new Schema(
  {
    version: {
      type: String,
      required: true,
      trim: true,
      match: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    },
    terms: { type: String, required: true, trim: true },
  },
  { _id: false, strict: "throw" },
);

const InspectionSchema = new Schema(
  {
    summary: { type: String, required: true, trim: true },
    inspectedAt: { type: Date },
    inspector: { type: String, trim: true },
  },
  { _id: false, strict: "throw" },
);

const ConditionEvidenceSchema = new Schema(
  {
    url: { type: String, required: true, trim: true },
    alt: { type: String, trim: true },
  },
  { _id: false, strict: "throw" },
);

const VariantSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    attributes: { type: Schema.Types.Mixed, required: true },
    price: {
      type: Number,
      required: true,
      validate: finiteNonNegative,
      index: true,
    },
    condition: {
      type: String,
      enum: Object.values(PRODUCT_CONDITION),
      required: true,
      index: true,
    },
    inspection: { type: InspectionSchema },
    limitations: { type: String, trim: true },
    conditionEvidence: { type: [ConditionEvidenceSchema], default: undefined },
    warranty: { type: WarrantyTermsSchema },
    sourcing: { type: SourcingSchema },
    inStock: { type: Number, validate: finiteNonNegative, index: true },
  },
  { timestamps: true },
);

VariantSchema.virtual("availability").get(function availability() {
  if (this.sourcing != null) return AVAILABILITY_STATUS.SOURCING;
  if (!Number.isFinite(this.inStock) || this.inStock < 0) {
    return AVAILABILITY_STATUS.OUT_OF_STOCK;
  }
  if (this.inStock === 0) return AVAILABILITY_STATUS.OUT_OF_STOCK;
  if (this.inStock <= LOW_STOCK_THRESHOLD) return AVAILABILITY_STATUS.LOW_STOCK;
  return AVAILABILITY_STATUS.IN_STOCK;
});

VariantSchema.set("toJSON", { virtuals: true });
VariantSchema.set("toObject", { virtuals: true });

VariantSchema.pre("validate", function validateInventoryMode() {
  const hasSourcing = this.sourcing != null;
  const hasStock = this.inStock != null;

  if (hasSourcing === hasStock) {
    const error = new mongoose.Error.ValidationError(this);
    error.addError(
      "inventoryMode",
      new mongoose.Error.ValidatorError({
        path: "inventoryMode",
        message: "A variant must have exactly one of sourcing or inStock",
      }),
    );
    throw error;
  }
});

export default mongoose.model("Variant", VariantSchema);
