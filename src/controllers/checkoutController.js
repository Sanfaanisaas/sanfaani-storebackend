import mongoose from "mongoose";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";

export const createCheckout = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const { shippingAddress, paymentMethod } = req.body;

  const session = await mongoose.startSession();
  let createdOrder;

  try {
    await session.withTransaction(async () => {
      // 1. Fetch user's cart (Server-side Cart)
      const cart = await Cart.findOne({ userId }).session(session);

      if (!cart || cart.items.length === 0) {
        throw new AppError("Cart is empty", 400);
      }

      const orderItems = [];
      let orderSubtotal = 0;

      // 2. Revalidate then reserve atomically
      for (const item of cart.items) {
        // Never trust the price or quantity the client sent - re-read from database
        const variant = await Variant.findOne({ sku: item.variantSku }).session(session);
        if (!variant) {
          throw new AppError(`Variant not found for SKU: ${item.variantSku}`, 404);
        }

        // Atomic reservation: check and mutation are one operation
        const updated = await Variant.findOneAndUpdate(
          { sku: item.variantSku, inStock: { $gte: item.quantity } },
          { $inc: { inStock: -item.quantity } },
          { new: true, session }
        );

        if (!updated) {
          throw new AppError(`Insufficient stock for ${item.variantSku}`, 409);
        }

        // Build order item snapshot
        const subtotal = item.quantity * variant.price;
        orderItems.push({
          productId: item.productId,
          variantSku: item.variantSku,
          quantity: item.quantity,
          price: variant.price,
          subtotal,
        });

        orderSubtotal += subtotal;
      }

      // 3. Create Order document
      const tax = 0;
      const shippingCost = 0;
      const total = orderSubtotal + tax + shippingCost;

      const order = await Order.create(
        [
          {
            user: userId,
            items: orderItems,
            shippingAddress,
            subtotal: orderSubtotal,
            tax,
            shippingCost,
            total,
            paymentMethod,
            paymentStatus: "pending",
            orderStatus: "processing",
          },
        ],
        { session }
      );

      createdOrder = order[0];

      // 4. Clear the cart
      await Cart.deleteOne({ userId }, { session });
    });

    res.status(201).json({
      success: true,
      data: createdOrder,
    });
  } finally {
    await session.endSession();
  }
});
