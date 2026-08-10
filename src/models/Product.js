import mongoose from "mongoose";
const { Schema, model } = mongoose;
import { PRODUCT_STATUS } from "../utils/constants.js";

const ProductSchema = new Schema({
  name: { type: String, required: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  description: { type: String, required: true },
  category: { type: String, required: true, index: true },
  brand: { type: String, required: true },
  images: [{ type: String }],
  status: { 
    type: String, 
    enum: Object.values(PRODUCT_STATUS), 
    default: PRODUCT_STATUS.DRAFT,
    index: true 
  },
  tags: [{ type: String }],
  isFeatured: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
  seo: {
    title: { type: String },
    description: { type: String }
  }
}, { timestamps: true });

export default model('Product', ProductSchema);