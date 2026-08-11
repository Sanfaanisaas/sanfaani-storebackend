import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CartSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  items: [
    {
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      variantSku: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      priceAtAdd: { type: Number, required: true },
    },
  ],
}, { timestamps: true });

const Cart = model('Cart', CartSchema);

export default Cart;
