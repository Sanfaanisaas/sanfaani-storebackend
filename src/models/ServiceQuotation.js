import mongoose from "mongoose";

export const SERVICE_QUOTATION_STATUSES = Object.freeze(["ISSUED", "APPROVED", "DECLINED", "EXPIRED", "SUPERSEDED"]);

const lineSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 500 },
  amount: { type: Number, required: true, min: 0 },
}, { _id: false });

const schema = new mongoose.Schema({
  serviceRequest: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceRequest", required: true, index: true, immutable: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  lineItems: { type: [lineSchema], validate: [(items) => items.length > 0, "Service quote requires line items"] },
  totalAmount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "NGN", match: /^[A-Z]{3}$/ },
  estimatedDays: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: SERVICE_QUOTATION_STATUSES, default: "ISSUED", index: true },
  superseded: { type: Boolean, default: false, index: true },
  isActionable: { type: Boolean, default: true, index: true },
  depositRequirement: { required: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 }, currency: { type: String, default: "NGN", match: /^[A-Z]{3}$/ }, dueBeforeWork: { type: Boolean, default: false } },
  paymentState: { status: { type: String, enum: ["not_required", "pending", "partially_confirmed", "confirmed", "failed"], default: "not_required" }, confirmedAmount: { type: Number, min: 0, default: 0 }, remainingAmount: { type: Number, min: 0, default: 0 } },
  decision: { type: { type: String, enum: ["APPROVED", "DECLINED"], default: null }, at: { type: Date, default: null }, idempotencyKey: { type: String, default: null, maxlength: 128 }, version: { type: Number, default: null } },
}, { timestamps: true });

schema.pre("validate", function validateQuote() {
  const sum = (this.lineItems || []).reduce((total, item) => total + item.amount, 0);
  if (sum !== this.totalAmount) this.invalidate("totalAmount", "Service quotation total must equal line-item arithmetic");
});
schema.index({ serviceRequest: 1, version: 1 }, { unique: true, name: "customer_service_quote_version" });
schema.index({ serviceRequest: 1, isActionable: 1 }, { unique: true, partialFilterExpression: { isActionable: true }, name: "one_actionable_customer_service_quote" });

export default mongoose.model("ServiceQuotation", schema);
