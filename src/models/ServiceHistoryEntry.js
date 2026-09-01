import mongoose from "mongoose";
import { SERVICE_TYPES, SERVICE_REQUEST_STATUSES } from "./ServiceRequest.js";

const schema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  serviceRequest: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceRequest", required: true, index: true, immutable: true },
  serviceReference: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
  serviceType: { type: String, enum: SERVICE_TYPES, required: true, immutable: true },
  deviceSafeLabel: { type: String, required: true, trim: true, maxlength: 200 },
  performedAt: { type: Date, required: true },
  status: { type: String, enum: SERVICE_REQUEST_STATUSES, required: true },
  workSummary: { type: String, required: true, trim: true, maxlength: 2000 },
  customerVisiblePartsAndServices: { type: [String], default: [] },
  warrantyOutcome: { type: String, trim: true, maxlength: 500, default: null },
  nextRecommendedMaintenance: { type: String, trim: true, maxlength: 500, default: null },
  authorizedDocuments: { type: [mongoose.Schema.Types.ObjectId], ref: "Evidence", default: [] },
}, { timestamps: true });

schema.index({ customer: 1, performedAt: -1 }, { name: "customer_service_history_list" });

export default mongoose.model("ServiceHistoryEntry", schema);
