import mongoose from "mongoose";
import Variant from "./Variant.js";

const { Schema, model } = mongoose;

const CartSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  guestId: { type: String, index: true },
  items: [
    {
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      variantSku: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
    },
  ],
}, { timestamps: true });

CartSchema.statics.mergeGuestCartIntoUser = async function(guestId, userId) {
  const [guestCart, userCart] = await Promise.all([
    this.findOne({ guestId }),
    this.findOneAndUpdate({ userId }, {}, { upsert: true, new: true }),
  ]);
  if (!guestCart) return userCart;

  for (const gItem of guestCart.items) {
    const existing = userCart.items.find((i) => i.variantSku === gItem.variantSku);
    if (existing) existing.quantity += gItem.quantity;
    else userCart.items.push(gItem);
  }
  await userCart.save();
  await guestCart.deleteOne();
  return userCart;
};

const Cart = model('Cart', CartSchema);

export default Cart;
