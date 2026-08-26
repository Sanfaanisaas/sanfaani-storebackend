import mongoose from "mongoose";
const schema = new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 120 }, code: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z0-9_-]{2,32}$/ }, active: { type: Boolean, default: true } }, { timestamps: true });
schema.index({ code: 1 }, { unique: true, name: "unique_inventory_location_code" });
export default mongoose.model("InventoryLocation", schema);
