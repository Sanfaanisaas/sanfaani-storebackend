import mongoose from "mongoose";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { isPayOnPickupEligible } from "../services/orderService.js";
import { recordStockMovement } from "../services/inventoryService.js";
import { ORDER_STATUS, STOCK_MOVEMENT_REASON } from "../utils/constants.js";

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

        // Atomic reservation: check and mutation are one operation via recordStockMovement
        const { variant: updated } = await recordStockMovement(
          variant._id,
          -item.quantity,
          STOCK_MOVEMENT_REASON.SALE,
          userId,
          session
        );

        // Build order item snapshot
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          throw new AppError(`Product not found for ID: ${item.productId}`, 404);
        }

        const subtotal = item.quantity * variant.price;
        orderItems.push({
          productId: item.productId,
          variantSku: item.variantSku,
          nameSnapshot: `${product.name} (${variant.name || variant.sku})`,
          priceSnapshot: variant.price,
          quantity: item.quantity,
        });

        orderSubtotal += subtotal;
      }

      // 3. Create Order document
      const tax = 0;
      const shippingCost = 0;
      const total = orderSubtotal + tax + shippingCost;

      // Validate Pay-on-pickup eligibility
      if (paymentMethod === 'pay_on_pickup') {
        const eligible = isPayOnPickupEligible({ total, shippingAddress });
        if (!eligible) {
          throw new AppError("Order not eligible for pay-on-pickup based on location or total amount", 400);
        }
      }

      const order = await Order.create(
        [
          {
            userId,
            items: orderItems,
            shippingAddress,
            subtotal: orderSubtotal,
            tax,
            shippingCost,
            total,
            paymentMethod,
            paymentStatus: "pending",
            status: ORDER_STATUS.PENDING_PAYMENT,
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
