import mongoose from "mongoose";

export const ORGANISATION_TYPES = Object.freeze([
  "business",
  "school",
  "nonprofit",
  "government",
  "other",
]);
export const ORGANISATION_STATUSES = Object.freeze(["ACTIVE", "SUSPENDED", "CLOSED"]);

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  normalizedName: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
  type: { type: String, enum: ORGANISATION_TYPES, required: true },
  billingEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  status: { type: String, enum: ORGANISATION_STATUSES, default: "ACTIVE", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
}, { timestamps: true });

schema.index({ createdBy: 1, idempotencyKey: 1 }, { unique: true, name: "organisation_creation_idempotency" });
schema.index({ normalizedName: 1, createdBy: 1 }, { name: "organisation_creator_name" });

export default mongoose.model("Organisation", schema);
