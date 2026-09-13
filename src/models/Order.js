import mongoose from "mongoose";
import { ORDER_STATUS } from "../utils/constants.js";

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantSku: { type: String, required: true },
    nameSnapshot: { type: String, required: true },
    priceSnapshot: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    assignedSerials: [{ type: String }],
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    items: [orderItemSchema],
    shippingAddress: {
      street: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, required: true, trim: true },
    },
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    shippingCost: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PENDING_PAYMENT,
    },
    paymentMethod: {
      type: String,
      enum: ["paystack", "bank_transfer", "pay_on_pickup"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "partially_refunded", "refunded"],
      default: "pending",
    },
    idempotencyKey: { type: String, trim: true, maxlength: 128 },
    requestFingerprint: { type: String, match: /^[a-f0-9]{64}$/ },
    paymentReference: { type: String },
    receiptUrl: { type: String },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    dueAt: { type: Date, default: null, index: true },
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },
    blockerCode: { type: String, default: null, maxlength: 64 },
    blockerMessage: { type: String, default: null, maxlength: 500 },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // BE-16 Fulfilment & Identity Tracking
    fulfilment: {
      identityDocumentType: {
        type: String,
        enum: ["ID_CARD", "PASSPORT", "DRIVERS_LICENSE", "OTHER"],
      },
      acknowledgedBy: { type: String },
      trackingReference: { type: String },
      courierName: { type: String },
      dispatchedAt: { type: Date },
      collectedAt: { type: Date },
      deliveredAt: { type: Date },
    },
  },
  { timestamps: true },
);

orderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "unique_checkout_idempotency_per_user",
  },
);

orderSchema.methods.toPublicOrder = function () {
  return {
    id: this._id,
    userId: this.userId,
    items: this.items,
    shippingAddress: this.shippingAddress,
    subtotal: this.subtotal,
    tax: this.tax,
    shippingCost: this.shippingCost,
    total: this.total,
    paymentMethod: this.paymentMethod,
    paymentStatus: this.paymentStatus,
    status: this.status,
    receiptUrl: this.receiptUrl,
    fulfilment: this.fulfilment,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Order = mongoose.model("Order", orderSchema);
export default Order;
