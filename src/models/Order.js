import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Variant",
      required: true,
    },
    sku: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    attributes: {
      type: Map,
      of: String,
      default: {},
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
    },
    subtotal: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: {
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
    subtotal: {
      type: Number,
      required: true,
    },
    tax: {
      type: Number,
      default: 0,
    },
    shippingCost: {
      type: Number,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["paystack", "bank_transfer", "pay_on_pickup"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: ["processing", "shipped", "delivered", "cancelled"],
      default: "processing",
    },
    paymentReference: {
      type: String,
    },
  },
  { timestamps: true }
);

orderSchema.methods.toPublicOrder = function () {
  return {
    id: this._id,
    user: this.user,
    items: this.items,
    shippingAddress: this.shippingAddress,
    subtotal: this.subtotal,
    tax: this.tax,
    shippingCost: this.shippingCost,
    total: this.total,
    paymentMethod: this.paymentMethod,
    paymentStatus: this.paymentStatus,
    orderStatus: this.orderStatus,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Order = mongoose.model("Order", orderSchema);

export default Order;
