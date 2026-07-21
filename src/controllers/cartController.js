import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import { catchAsync } from "../utils/catchAsync.js";

const populateOptions = {
  path: "items.variant",
};

/**
 * Map cart items to public objects using Variant.toPublicObject()
 */
const formatCartResponse = (cart) => {
  if (!cart) return { items: [] };
  
  const items = cart.items.map((item) => {
    const variantObj = item.variant.toPublicObject ? item.variant.toPublicObject() : item.variant;
    return {
      variant: variantObj,
      quantity: item.quantity,
    };
  });

  return { items };
};

export const getCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const cart = await Cart.findOne({ user: userId }).populate(populateOptions);
  
  res.status(200).json({
    success: true,
    data: formatCartResponse(cart),
  });
});

export const addItem = catchAsync(async (req, res) => {
  const { variantId, quantity } = req.body;
  const userId = req.user.id || req.user._id;

  const variant = await Variant.findById(variantId);
  if (!variant) {
    return res.status(404).json({ success: false, message: "Variant not found" });
  }

  if (!variant.in_stock) {
    return res.status(400).json({ success: false, message: "Variant is out of stock" });
  }

  if (quantity > variant.stockQuantity) {
    return res.status(400).json({
      success: false,
      message: `Requested quantity exceeds available stock (${variant.stockQuantity})`,
    });
  }

  let cart = await Cart.findOne({ user: userId });

  if (!cart) {
    cart = new Cart({ user: userId, items: [] });
  }

  const existingItemIndex = cart.items.findIndex(
    (item) => item.variant.toString() === variantId
  );

  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity = quantity;
  } else {
    cart.items.push({ variant: variantId, quantity });
  }

  await cart.save();
  await cart.populate(populateOptions);

  res.status(200).json({
    success: true,
    data: formatCartResponse(cart),
  });
});

export const removeItem = catchAsync(async (req, res) => {
  const { variantId } = req.params;
  const userId = req.user.id || req.user._id;

  const cart = await Cart.findOne({ user: userId });
  if (cart) {
    cart.items = cart.items.filter(
      (item) => item.variant.toString() !== variantId
    );
    await cart.save();
    await cart.populate(populateOptions);
  }

  res.status(200).json({
    success: true,
    data: formatCartResponse(cart),
  });
});

export const mergeCart = catchAsync(async (req, res) => {
  const { guestItems } = req.body;
  const userId = req.user.id || req.user._id;

  let cart = await Cart.findOne({ user: userId });

  if (!cart) {
    cart = new Cart({ user: userId, items: [] });
  }

  await cart.mergeGuestItems(guestItems);
  await cart.populate(populateOptions);

  res.status(200).json({
    success: true,
    data: formatCartResponse(cart),
  });
});
