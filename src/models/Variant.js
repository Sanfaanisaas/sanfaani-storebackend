import mongoose from "mongoose";
const { Schema } = mongoose;
import { PRODUCT_CONDITION } from "../utils/constants.js";

const SourcingSchema = new Schema({
  supplier: { type: String, required: true },
  leadTimeDays: { type: Number, required: true, min: 0 },
  costPrice: { type: Number, required: true, min: 0 },
}, { _id: false });

const VariantSchema = new Schema({
  sku: { type: String, required: true, unique: true },
  attributes: { type: Schema.Types.Mixed, required: true },
  price: { type: Number, required: true, min: 0 },
  condition: { type: String, enum: Object.values(PRODUCT_CONDITION), required: true },
  sourcing: { type: SourcingSchema, required: false },
  inStock: { type: Number, min: 0, required: false },
});

VariantSchema.pre('validate', function (next) {
  const hasSourcing = this.sourcing != null;
  const hasStock = this.inStock != null;
  if (hasSourcing === hasStock) {
    return next(new Error('A variant must have exactly one of `sourcing` or `inStock` — never both, never neither.'));
  }
  next();
});

export default VariantSchema;