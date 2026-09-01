import mongoose from "mongoose";
const recommendation = new mongoose.Schema({ variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant", required: true }, score: { type: Number, required: true }, factors: { type: [String], default: [] }, availability: { type: String, required: true } }, { _id: false });
const summary = new mongoose.Schema({ budget: { type: Number, default: null }, useCase: { type: String, default: null }, brands: { type: [String], default: [] }, categories: { type: [String], default: [] }, requiredFeatures: { type: [String], default: [] } }, { _id: false });
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  resumeDigest: { type: String, unique: true, sparse: true, select: false },
  resumeExpiresAt: { type: Date, default: null },
  resumeRevokedAt: { type: Date, default: null },
  budget: { type: Number, min: 0, default: null },
  useCase: { type: String, trim: true, maxlength: 120, default: null },
  brands: { type: [String], default: [] },
  categories: { type: [String], default: [] },
  requiredFeatures: { type: [String], default: [] },
  requirementsSummary: { type: summary, default: () => ({}) },
  rulesVersion: { type: String, required: true, default: "catalogue-budget-v1", maxlength: 64 },
  evaluatedAt: { type: Date, default: Date.now },
  staleAt: { type: Date, default: null },
  recommendations: { type: [recommendation], default: [] },
  status: { type: String, enum: ["ACTIVE", "NO_MATCH", "STALE", "ARCHIVED"], default: "ACTIVE" },
  archivedAt: { type: Date, default: null },
  advisorNotes: { type: String, select: false, maxlength: 2000, default: null },
  escalatedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ resumeExpiresAt: 1 }, { expireAfterSeconds: 0, name: "guidance_resume_expiry" });
schema.index({ owner: 1, updatedAt: -1 }, { name: "owner_guidance_sessions" });
export default mongoose.model("GuidanceSession", schema);
