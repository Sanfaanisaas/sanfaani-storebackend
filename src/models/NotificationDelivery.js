import mongoose from "mongoose";

const schema = new mongoose.Schema({
  notification: { type: mongoose.Schema.Types.ObjectId, ref: "Notification", required: true, immutable: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  channel: { type: String, enum: ["email", "push"], required: true, immutable: true },
  status: { type: String, enum: ["PENDING", "PROCESSING", "RETRY_SCHEDULED", "DELIVERED", "SUPPRESSED", "DEAD_LETTER"], default: "PENDING", index: true },
  attempts: { type: Number, min: 0, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lockedUntil: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  suppressedAt: { type: Date, default: null },
  deadLetteredAt: { type: Date, default: null },
  lastErrorCategory: { type: String, enum: ["provider_unavailable", "provider_rejected", "recipient_unavailable", null], default: null },
  providerMessageDigest: { type: String, match: /^[a-f0-9]{64}$/, default: null, select: false },
  invalidatedDeviceCount: { type: Number, min: 0, default: 0 },
}, { timestamps: true, versionKey: false });

schema.index({ notification: 1, channel: 1 }, { unique: true, name: "notification_delivery_channel" });
schema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 }, { name: "notification_outbox_claim" });

export default mongoose.model("NotificationDelivery", schema);
