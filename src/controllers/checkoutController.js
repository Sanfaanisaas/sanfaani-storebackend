import mongoose from "mongoose";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { isPayOnPickupEligible } from "../services/orderService.js";
import {
  assertLocalInventory,
  recordStockMovement,
} from "../services/inventoryService.js";
import { ORDER_STATUS, STOCK_MOVEMENT_REASON, PRODUCT_STATUS } from "../utils/constants.js";

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

      // 2. Collect every stock and price conflict before reserving anything
      const conflicts = [];

      for (const item of cart.items) {
        const variant = await Variant.findOne({ sku: item.variantSku }).session(session);

        if (!variant) {
          conflicts.push({
            variantSku: item.variantSku,
            type: "out_of_stock",
            message: `Variant ${item.variantSku} no longer exists`,
          });
          continue;
        }

        if (variant.inStock < item.quantity) {
          conflicts.push({
            variantSku: item.variantSku,
            type: "out_of_stock",
            message:
              variant.inStock === 0
                ? `${item.variantSku} is out of stock`
                : `Only ${variant.inStock} unit(s) of ${item.variantSku} available (you have ${item.quantity} in cart)`,
            availableStock: variant.inStock,
          });
        }

        if (item.priceAtAdd !== variant.price) {
          const oldPriceLabel = Number.isFinite(item.priceAtAdd)
            ? item.priceAtAdd.toLocaleString()
            : "unknown";
          conflicts.push({
            variantSku: item.variantSku,
            type: "price_changed",
            message: `Price of ${item.variantSku} changed from ₦${oldPriceLabel} to ₦${variant.price.toLocaleString()}`,
            oldPrice: item.priceAtAdd,
            newPrice: variant.price,
          });
        }
      }

      if (conflicts.length > 0) {
        throw new AppError("Some items in your cart have changed", 409, conflicts);
      }

      // 3. Reserve stock and build the order only when there are no conflicts
      const orderItems = [];
      let orderSubtotal = 0;

      for (const item of cart.items) {
        const variant = await Variant.findOne({ sku: item.variantSku }).session(session);

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          throw new AppError(`Product not found for ID: ${item.productId}`, 404);
        }

        if (product.status !== PRODUCT_STATUS.ACTIVE) {
          throw new AppError(`Product '${product.name}' is not currently available for purchase`, 400);
        }

        if (!variant.product || variant.product.toString() !== product._id.toString()) {
          throw new AppError(`Integrity error: Variant ${variant.sku} does not belong to product ${product.name}`, 400);
        }

        assertLocalInventory(variant, item.quantity);

        // Atomic reservation: check and mutation are one operation via recordStockMovement
        await recordStockMovement(
          variant._id,
          -item.quantity,
          STOCK_MOVEMENT_REASON.SALE,
          userId,
          session
        );

        const subtotal = item.quantity * variant.price;
        orderItems.push({
          productId: item.productId,
          variantSku: item.variantSku,
          nameSnapshot: `${product.name} (${variant.sku})`,
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
