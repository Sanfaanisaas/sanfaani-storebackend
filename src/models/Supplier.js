import mongoose from "mongoose";
const schema = new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 160 }, email: { type: String, trim: true, lowercase: true, maxlength: 254 }, phone: { type: String, trim: true, maxlength: 64 }, active: { type: Boolean, default: true }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true } }, { timestamps: true });
schema.index({ name: 1 }, { unique: true, name: "unique_supplier_name" });
export default mongoose.model("Supplier", schema);
