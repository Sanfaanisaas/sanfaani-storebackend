import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import { catchAsync } from "../utils/catchAsync.js";

/**
 * Format cart for response
 */
const formatCartResponse = async (cart) => {
  if (!cart) return { items: [] };
  
  const items = [];
  for (const item of cart.items) {
    const variant = await Variant.findOne({ sku: item.variantSku });
    const product = await Product.findById(item.productId);
    items.push({
      product: {
        id: product?._id,
        name: product?.name,
      },
      variantSku: item.variantSku,
      price: variant?.price,
      quantity: item.quantity,
      inStock: variant?.inStock,
    });
  }

  return { items };
};

export const getCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const cart = await Cart.findOne({ userId });
  
  res.status(200).json({
    success: true,
    data: await formatCartResponse(cart),
  });
});

export const addItem = catchAsync(async (req, res) => {
  const { productId, variantSku, quantity } = req.body;
  const userId = req.user.id || req.user._id;

  const variant = await Variant.findOne({ sku: variantSku });
  if (!variant) {
    return res.status(404).json({ success: false, message: "Variant not found" });
  }

  if (variant.inStock === 0) {
    return res.status(400).json({ success: false, message: "Variant is out of stock" });
  }

  if (quantity > (variant.inStock || 0)) {
    return res.status(400).json({
      success: false,
      message: `Requested quantity exceeds available stock (${variant.inStock})`,
    });
  }

  let cart = await Cart.findOne({ userId });

  if (!cart) {
    cart = new Cart({ userId, items: [] });
  }

  const existingItemIndex = cart.items.findIndex(
    (item) => item.variantSku === variantSku
  );

  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity = quantity;
  } else {
    cart.items.push({ productId, variantSku, quantity });
  }

  await cart.save();

  res.status(200).json({
    success: true,
    data: await formatCartResponse(cart),
  });
});

export const removeItem = catchAsync(async (req, res) => {
  const { variantSku } = req.params;
  const userId = req.user.id || req.user._id;

  const cart = await Cart.findOne({ userId });
  if (cart) {
    cart.items = cart.items.filter(
      (item) => item.variantSku !== variantSku
    );
    await cart.save();
  }

  res.status(200).json({
    success: true,
    data: await formatCartResponse(cart),
  });
});

export const mergeCart = catchAsync(async (req, res) => {
  const { guestId } = req.body;
  const userId = req.user.id || req.user._id;

  const cart = await Cart.mergeGuestCartIntoUser(guestId, userId);

  res.status(200).json({
    success: true,
    data: await formatCartResponse(cart),
  });
});
