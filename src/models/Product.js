import mongoose from "mongoose";
const { Schema, model } = mongoose;
import VariantSchema from "./Variant.js";

const ProductSchema = new Schema({
  name: { type: String, required: true, index: true },
  description: { type: String, required: true },
  category: { type: String, required: true, index: true },
  variants: { type: [VariantSchema], required: true, validate: (v) => v.length > 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export default model('Product', ProductSchema);