import mongoose from "mongoose";

export const CUSTOMER_NOTIFICATION_RESOURCE_TYPES = Object.freeze([
  "repair", "claim", "return", "support_ticket", "guidance",
  "procurement_request", "procurement_quotation", "service_request",
  "service_quotation", "maintenance_plan",
]);

const schema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  type: { type: String, required: true, trim: true, maxlength: 64, immutable: true },
  title: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
  safePreview: { type: String, required: true, trim: true, maxlength: 500, immutable: true },
  resourceType: { type: String, enum: CUSTOMER_NOTIFICATION_RESOURCE_TYPES, required: true, immutable: true },
  resourceId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  mandatory: { type: Boolean, default: false, immutable: true },
  readAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null, index: true },
  eventKey: { type: String, required: true, maxlength: 160, immutable: true, select: false },
}, { timestamps: true });

schema.index({ recipient: 1, eventKey: 1 }, { unique: true, name: "unique_customer_notification_event" });
schema.index({ recipient: 1, readAt: 1, createdAt: -1 }, { name: "customer_notification_inbox" });

export default mongoose.model("Notification", schema);
