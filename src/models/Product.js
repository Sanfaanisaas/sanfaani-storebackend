import mongoose from "mongoose";
const { Schema, model } = mongoose;
import VariantSchema from "./Variant.js";

const ProductSchema = new Schema({
  name: { type: String, required: true, index: true },
  description: { type: String, required: true },
  category: { type: String, required: true, index: true },
  variants: [{ type: Schema.Types.ObjectId, ref: 'Variant' }],
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export default model('Product', ProductSchema);