import mongoose from "mongoose";
import Variant from "./Variant.js";

const cartItemSchema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Variant",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    items: [cartItemSchema],
  },
  { timestamps: true }
);

/**
 * Merges guest items into the user's cart.
 * If a variant already exists in the user's cart, the user's item is kept (logged-in wins).
 * Otherwise, the guest item is added after validation.
 * @param {Array} guestItems - Array of { variantId, quantity }
 * @returns {Promise<Object>} - The updated cart document
 */
cartSchema.methods.mergeGuestItems = async function (guestItems) {
  for (const guestItem of guestItems) {
    const variant = await Variant.findById(guestItem.variantId);

    if (!variant) {
      throw new Error(`Variant ${guestItem.variantId} not found`);
    }

    if (!variant.in_stock) {
      throw new Error(`Variant ${variant.sku} is not in stock`);
    }

    const existingItem = this.items.find(
      (item) => item.variant.toString() === guestItem.variantId.toString()
    );

    if (existingItem) {
      // Logged-in cart wins, skip
      continue;
    }

    if (guestItem.quantity > variant.stockQuantity) {
      throw new Error(`Requested quantity for ${variant.sku} exceeds available stock`);
    }

    this.items.push({
      variant: variant._id,
      quantity: guestItem.quantity,
    });
  }

  return await this.save();
};

const Cart = mongoose.model("Cart", cartSchema);

export default Cart;
