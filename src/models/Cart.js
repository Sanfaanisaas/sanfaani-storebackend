import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CartSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  items: [
    {
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      variantSku: { type: String, required: true, trim: true },
      quantity: {
        type: Number,
        required: true,
        min: 1,
        validate: {
          validator: Number.isInteger,
          message: "Cart quantity must be a positive integer",
        },
      },
      // Optional only so pre-BE-02 lines remain readable. Every successful
      // add, set, or merge operation writes a trusted current database price.
      priceAtAdd: {
        type: Number,
        validate: {
          validator: (value) => value == null || (Number.isFinite(value) && value >= 0),
          message: "Cart priceAtAdd must be a finite non-negative number",
        },
      },
    },
  ],
}, { timestamps: true, optimisticConcurrency: true });

// Prevent new duplicate authenticated carts without mutating or attempting to
// merge any existing production duplicates. Index creation will surface legacy
// duplicates for deliberate operational reconciliation.
CartSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $type: "objectId" } },
    name: "unique_active_cart_per_user",
  },
);

const Cart = model('Cart', CartSchema);

export default Cart;
