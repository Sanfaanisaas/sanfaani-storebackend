import mongoose from "mongoose";

const { Schema } = mongoose;

const repairTrackingTokenSchema = new Schema({
  repair: { type: Schema.Types.ObjectId, ref: "Repair", required: true, index: true },
  digest: { type: String, required: true, unique: true, immutable: true },
  scope: { type: String, required: true, enum: ["repair:track"], immutable: true },
  issuedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, versionKey: false });

repairTrackingTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "repair_tracking_expiry_cleanup" });
repairTrackingTokenSchema.index({ repair: 1, scope: 1, revokedAt: 1 }, { name: "repair_tracking_active_lookup" });

export default mongoose.model("RepairTrackingToken", repairTrackingTokenSchema);
