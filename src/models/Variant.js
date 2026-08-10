import mongoose from "mongoose";
const { Schema } = mongoose;
import { PRODUCT_CONDITION, AVAILABILITY_STATUS, LOW_STOCK_THRESHOLD } from "../utils/constants.js";

const SourcingSchema = new Schema({
  supplier: { type: String, required: true },
  leadTimeDays: { type: Number, required: true, min: 0 },
  costPrice: { type: Number, required: true, min: 0 },
}, { _id: false });

const VariantSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  sku: { type: String, required: true, unique: true },
  attributes: { type: Schema.Types.Mixed, required: true },
  price: { type: Number, required: true, min: 0 },
  condition: { type: String, enum: Object.values(PRODUCT_CONDITION), required: true },
  inspectionSummary: { type: String },
  limitations: { type: String },
  conditionEvidence: [{ type: String }],
  warrantyTerms: { type: String },
  sourcing: { type: SourcingSchema, required: false },
  inStock: { type: Number, min: 0, required: false },
});

VariantSchema.virtual('availability').get(function() {
  if (this.sourcing) return AVAILABILITY_STATUS.SOURCING;
  if (this.inStock === 0) return AVAILABILITY_STATUS.OUT_OF_STOCK;
  if (this.inStock <= LOW_STOCK_THRESHOLD) return AVAILABILITY_STATUS.LOW_STOCK;
  return AVAILABILITY_STATUS.IN_STOCK;
});

VariantSchema.set('toJSON', { virtuals: true });
VariantSchema.set('toObject', { virtuals: true });

VariantSchema.methods.toPublicObject = function () {
  const obj = this.toObject();
  delete obj.sourcing;
  delete obj.__v;
  return obj;
};

VariantSchema.pre('validate', function (next) {
  const hasSourcing = this.sourcing != null;
  const hasStock = this.inStock != null;
  if (hasSourcing === hasStock) {
    return next(new Error('A variant must have exactly one of `sourcing` or `inStock` — never both, never neither.'));
  }
  next();
});

export default mongoose.model("Variant", VariantSchema);