import mongoose from "mongoose";
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 64 },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  deactivatedAt: { type: Date, default: null },
  deactivationReason: { type: String, trim: true, maxlength: 500, default: null },
  procurementRevision: { type: Number, default: 0, min: 0, select: false },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ name: 1 }, { unique: true, name: "unique_supplier_name" });
export default mongoose.model("Supplier", schema);
