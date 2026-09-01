import mongoose from "mongoose";

export const PROCUREMENT_QUOTATION_STATUSES = Object.freeze(["ISSUED", "APPROVED", "DECLINED", "EXPIRED", "SUPERSEDED"]);

const lineSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 500 },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
}, { _id: false });

const schema = new mongoose.Schema({
  request: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementRequest", required: true, index: true, immutable: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  lineItems: { type: [lineSchema], validate: [(items) => items.length > 0, "Quotation requires line items"] },
  subtotal: { type: Number, required: true, min: 0 },
  tax: { type: Number, required: true, min: 0, default: 0 },
  fees: { type: Number, required: true, min: 0, default: 0 },
  fulfilmentCharge: { type: Number, required: true, min: 0, default: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "NGN", match: /^[A-Z]{3}$/ },
  validUntil: { type: Date, required: true, index: true },
  termsVersion: { type: String, required: true, maxlength: 64 },
  warrantySummary: { type: String, trim: true, maxlength: 1500, default: null },
  supportSummary: { type: String, trim: true, maxlength: 1500, default: null },
  status: { type: String, enum: PROCUREMENT_QUOTATION_STATUSES, default: "ISSUED", index: true },
  superseded: { type: Boolean, default: false, index: true },
  isActionable: { type: Boolean, default: true, index: true },
  documentEvidence: { type: mongoose.Schema.Types.ObjectId, ref: "Evidence", default: null },
  conversionStatus: { type: String, enum: ["NOT_STARTED", "PENDING", "CONVERTED"], default: "NOT_STARTED" },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  decision: { type: { type: String, enum: ["APPROVED", "DECLINED"], default: null }, at: { type: Date, default: null }, idempotencyKey: { type: String, default: null, maxlength: 128 }, version: { type: Number, default: null } },
}, { timestamps: true });

schema.pre("validate", function validateArithmetic() {
  const computed = this.subtotal + this.tax + this.fees + this.fulfilmentCharge;
  if (this.totalAmount !== computed) this.invalidate("totalAmount", "Quotation total must equal subtotal plus tax, fees, and fulfilment charge");
  for (const item of this.lineItems || []) if (item.totalAmount !== item.quantity * item.unitPrice) this.invalidate("lineItems", "Quotation line total must equal quantity times unit price");
});
schema.index({ request: 1, version: 1 }, { unique: true, name: "customer_procurement_quote_version" });
schema.index({ request: 1, isActionable: 1 }, { unique: true, partialFilterExpression: { isActionable: true }, name: "one_actionable_customer_procurement_quote" });

export default mongoose.model("ProcurementQuotation", schema);
