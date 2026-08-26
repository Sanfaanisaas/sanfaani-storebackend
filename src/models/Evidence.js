import mongoose from "mongoose";

const schema = new mongoose.Schema({
  subjectType: { type: String, enum: ["order", "repair"], required: true, index: true },
  subject: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  purpose: { type: String, required: true },
  displayName: { type: String, required: true, maxlength: 160 },
  objectKey: { type: String, required: true, unique: true, select: false },
  checksum: { type: String, required: true },
  detectedMimeType: { type: String, required: true },
  size: { type: Number, required: true, min: 1 },
  uploader: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  retentionState: { type: String, enum: ["ACTIVE", "DELETE_PENDING", "DELETED", "LEGAL_HOLD"], default: "ACTIVE" },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ subjectType: 1, subject: 1, purpose: 1 });
export default mongoose.model("Evidence", schema);
