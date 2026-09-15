import mongoose from "mongoose";

const { Schema } = mongoose;

const lineItemSchema = new Schema(
  {
    name: { type: String, required: true },
    sku: { type: String, required: true },
    unitAmount: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const financialDocumentSchema = new Schema(
  {
    documentKey: { type: String, required: true, unique: true },
    documentNumber: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["INVOICE", "RECEIPT"], required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    payment: { type: Schema.Types.ObjectId, ref: "Payment", default: null, index: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    issuedAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, min: 1, default: 1 },
    snapshot: {
      items: { type: [lineItemSchema], required: true },
      subtotal: { type: Number, required: true, min: 0 },
      tax: { type: Number, required: true, min: 0 },
      shipping: { type: Number, required: true, min: 0 },
      total: { type: Number, required: true, min: 0 },
      paymentMethod: {
        type: String,
        enum: ["paystack", "bank_transfer", "pay_on_pickup"],
        required: true,
      },
      paidAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

financialDocumentSchema.index({ owner: 1, order: 1, kind: 1 });

financialDocumentSchema.pre("validate", function () {
  const amounts = [
    this.snapshot?.subtotal,
    this.snapshot?.tax,
    this.snapshot?.shipping,
    this.snapshot?.total,
    ...(this.snapshot?.items || []).flatMap((item) => [item.unitAmount, item.lineTotal]),
  ];
  if (!amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)) {
    this.invalidate("snapshot.total", "Financial values must be non-negative integer minor units");
    return;
  }
  const lineTotal = this.snapshot.items.reduce((sum, item) => {
    if (item.lineTotal !== item.unitAmount * item.quantity) {
      this.invalidate("snapshot.items", "Line totals must equal unit amount multiplied by quantity");
    }
    return sum + item.lineTotal;
  }, 0);
  if (lineTotal !== this.snapshot.subtotal) {
    this.invalidate("snapshot.subtotal", "Line totals must equal the subtotal");
  }
  if (this.snapshot.subtotal + this.snapshot.tax + this.snapshot.shipping !== this.snapshot.total) {
    this.invalidate("snapshot.total", "Subtotal, tax, and shipping must equal the total");
  }
  if (this.kind === "RECEIPT" && (!this.payment || !this.snapshot.paidAt)) {
    this.invalidate("payment", "Receipts require a verified payment and paid timestamp");
  }
});

const rejectMutation = function () {
  throw new Error("Financial documents are immutable");
};
financialDocumentSchema.pre("save", function () {
  if (!this.isNew) throw new Error("Financial documents are immutable");
});
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  financialDocumentSchema.pre(operation, rejectMutation);
}

export default mongoose.model("FinancialDocument", financialDocumentSchema);
