import mongoose from "mongoose";
import { catchAsync } from "../utils/catchAsync.js";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";

export const createCheckout = catchAsync(async (req, res) => {
  const { items: requestItems, shippingAddress, paymentMethod } = req.body;
  const userId = req.user.id;

  const session = await mongoose.startSession();
  let createdOrder;

  try {
    await session.withTransaction(async () => {
      // a. Fetch user's cart
      const cart = await Cart.findOne({ user: userId })
        .populate({
          path: "items.variant",
          populate: { path: "product" },
        })
        .session(session);

      if (!cart || cart.items.length === 0) {
        throw new Error("Cart is empty");
      }

      const orderItems = [];
      let orderSubtotal = 0;

      // b. Process each item from request
      for (const reqItem of requestItems) {
        const { variantId, price: reqPrice, quantity: reqQuantity } = reqItem;

        // Find matching cart item
        const cartItem = cart.items.find(
          (item) => item.variant._id.toString() === variantId
        );

        if (!cartItem) {
          throw new Error(`Item ${variantId} not found in cart`);
        }

        if (reqQuantity > cartItem.quantity) {
          throw new Error(`Requested quantity for ${variantId} exceeds cart quantity`);
        }

        const variant = cartItem.variant;
        const product = variant.product;

        // Verify price mismatch
        if (variant.price !== reqPrice) {
          throw new Error(`Price mismatch for variant ${variant.sku || variantId}`);
        }

        // Perform atomic stock reservation
        const updatedVariant = await Variant.findOneAndUpdate(
          {
            _id: variantId,
            in_stock: true,
            stockQuantity: { $gte: reqQuantity },
          },
          { $inc: { stockQuantity: -reqQuantity } },
          { new: true, session }
        );

        if (!updatedVariant) {
          throw new Error(`Insufficient stock for variant ${variant.sku || variantId}`);
        }

        // Build order item snapshot
        const subtotal = reqQuantity * variant.price;
        orderItems.push({
          variant: variant._id,
          sku: variant.sku,
          name: product.name,
          attributes: variant.attributes,
          quantity: reqQuantity,
          price: variant.price,
          subtotal,
        });

        orderSubtotal += subtotal;
      }

      // c. Create Order document
      const tax = 0; // Default as per instructions
      const shippingCost = 0; // Default as per instructions
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

      // d. Clear the cart
      await Cart.deleteOne({ user: userId }, { session });
    });

    // e. Return created order
    res.status(201).json({
      success: true,
      data: createdOrder,
    });
  } catch (error) {
    // Error is already caught by withTransaction and re-thrown
    // but we need to handle it or let catchAsync handle it.
    // withTransaction aborts automatically on error.
    throw error;
  } finally {
    session.endSession();
  }
});
