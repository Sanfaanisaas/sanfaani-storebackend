import mongoose from "mongoose";

export const OPTIONAL_NOTIFICATION_CATEGORIES = Object.freeze([
  "repair_updates", "claims_returns", "support_updates", "guidance_updates",
  "procurement_updates", "service_updates",
]);

const categorySchema = new mongoose.Schema(
  Object.fromEntries(OPTIONAL_NOTIFICATION_CATEGORIES.map((category) => [category, { type: Boolean, default: true }])),
  { _id: false },
);

const schema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, immutable: true },
  version: { type: String, required: true, default: "2026-08", immutable: true },
  optionalCategories: { type: categorySchema, default: () => ({}) },
  channels: {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: false },
    sms: { type: Boolean, default: false },
    push: { type: Boolean, default: false },
  },
  consentUpdatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.model("NotificationPreference", schema);
