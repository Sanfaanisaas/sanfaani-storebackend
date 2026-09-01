import mongoose from "mongoose";
import { CLAIM_STATUS } from "../utils/constants.js";
const { Schema } = mongoose;

const timelineSchema = new Schema({
  status: { type: String, enum: Object.values(CLAIM_STATUS), required: true },
  at: { type: Date, required: true, default: Date.now },
  message: { type: String, trim: true, maxlength: 500, default: null },
}, { _id: false });
const informationRequestSchema = new Schema({
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  dueAt: { type: Date, default: null },
  fulfilledAt: { type: Date, default: null },
}, { _id: true });
const remedySchema = new Schema({
  type: { type: String, enum: ["repair", "replacement", "refund", "store_credit"], default: null },
  summary: { type: String, trim: true, maxlength: 1500, default: null },
  outcome: { type: String, trim: true, maxlength: 1500, default: null },
}, { _id: false });

const ClaimSchema = new Schema({
  warranty: { type: Schema.Types.ObjectId, ref: "Warranty", required: true, index: true },
  repair: { type: Schema.Types.ObjectId, ref: "Repair", default: null },
  submittedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  description: { type: String, required: true, trim: true, minlength: 3, maxlength: 4000 },
  status: { type: String, enum: Object.values(CLAIM_STATUS), default: CLAIM_STATUS.SUBMITTED },
  active: { type: Boolean, default: true, index: true },
  customerSafeTimeline: { type: [timelineSchema], default: () => [{ status: CLAIM_STATUS.SUBMITTED, at: new Date(), message: "Claim submitted" }] },
  nextAction: { type: String, trim: true, maxlength: 500, default: null },
  informationRequests: { type: [informationRequestSchema], default: [] },
  remedy: { type: remedySchema, default: () => ({}) },
  customerSafeReason: { type: String, trim: true, maxlength: 1000, default: null },
  resolutionNotes: { type: String, select: false, maxlength: 2000 },
}, { timestamps: true });

ClaimSchema.index({ warranty: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_claim_per_warranty" });
ClaimSchema.set("toJSON", { transform: (doc, ret) => { delete ret.resolutionNotes; return ret; } });
export default mongoose.model("Claim", ClaimSchema);
