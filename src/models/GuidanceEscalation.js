import mongoose from "mongoose";

export const GUIDANCE_ESCALATION_STATUSES = Object.freeze(["submitted", "in_review", "responded", "closed"]);

const schema = new mongoose.Schema({
  guidanceSession: { type: mongoose.Schema.Types.ObjectId, ref: "GuidanceSession", required: true, index: true, immutable: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  question: { type: String, required: true, trim: true, minlength: 3, maxlength: 1000, immutable: true },
  status: { type: String, enum: GUIDANCE_ESCALATION_STATUSES, default: "submitted", index: true },
  response: { type: String, trim: true, maxlength: 2000, default: null },
  respondedAt: { type: Date, default: null },
  advisorDisplayName: { type: String, trim: true, maxlength: 120, default: null },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

schema.index({ guidanceSession: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_guidance_escalation" });

export default mongoose.model("GuidanceEscalation", schema);
