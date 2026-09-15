import mongoose from "mongoose";
import { CONTENT_STATUSES } from "./ContentPage.js";

export const policyAcceptanceSchema = new mongoose.Schema({
  policyVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "PolicyVersion", required: true, immutable: true },
  key: { type: String, required: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  acceptedAt: { type: Date, required: true, immutable: true },
}, { _id: false });

const schema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, lowercase: true, match: /^[a-z0-9]+(?:_[a-z0-9]+)*$/, immutable: true },
  locale: { type: String, required: true, trim: true, default: "en-NG", match: /^[a-z]{2}(?:-[A-Z]{2})?$/, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  title: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
  summary: { type: String, required: true, trim: true, maxlength: 500, immutable: true },
  body: { type: String, required: true, maxlength: 100000, immutable: true },
  effectiveAt: { type: Date, required: true, immutable: true },
  status: { type: String, enum: CONTENT_STATUSES, default: "DRAFT", index: true },
  stateVersion: { type: Number, min: 0, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, select: false, immutable: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, select: false },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, select: false },
  submittedAt: { type: Date, default: null },
  reviewedAt: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  supersededAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
  idempotencyKey: { type: String, required: true, maxlength: 128, select: false, immutable: true },
  idempotencyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false, immutable: true },
}, { timestamps: true, versionKey: false });

schema.index({ key: 1, locale: 1, version: 1 }, { unique: true, name: "policy_document_version" });
schema.index({ key: 1, locale: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "PUBLISHED" }, name: "current_published_policy" });
schema.index({ createdBy: 1, idempotencyKey: 1 }, { unique: true, name: "policy_version_idempotency" });

export default mongoose.model("PolicyVersion", schema);
