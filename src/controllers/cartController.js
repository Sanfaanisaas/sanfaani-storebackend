import mongoose from "mongoose";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { PRODUCT_STATUS } from "../utils/constants.js";
import { assertLocalInventory } from "../services/inventoryService.js";

const CART_WRITE_RETRIES = 5;

const conflict = (type, message, details = {}) => ({ type, message, ...details });

const inventoryConflict = (variant, quantity, error) => {
  if (variant?.sourcing != null) {
    return conflict(
      "sourcing_unavailable",
      `Variant ${variant.sku} is sourcing-only and cannot be purchased`,
      { variantSku: variant.sku },
    );
  }
  if (!Number.isFinite(variant?.inStock) || variant.inStock < 0) {
    return conflict(
      "invalid_stock",
      `Variant ${variant?.sku || "unknown"} has invalid local inventory`,
      { variantSku: variant?.sku },
    );
  }
  return conflict(
    "insufficient_stock",
    error.message,
    { variantSku: variant.sku, requestedQuantity: quantity },
  );
};

const assertPurchasableInventory = (variant, quantity) => {
  try {
    assertLocalInventory(variant, quantity);
  } catch (error) {
    throw new AppError(
      "Cart item is not available",
      409,
      [inventoryConflict(variant, quantity, error)],
    );
  }
};

const loadPurchasableVariant = async ({ productId, variantSku }) => {
  const [product, variant] = await Promise.all([
    Product.findById(productId),
    Variant.findOne({ sku: variantSku }),
  ]);

  if (!product) {
    throw new AppError("Product not available", 404, [
      conflict("product_missing", "Product no longer exists", { productId }),
    ]);
  }
  if (!variant) {
    throw new AppError("Variant not available", 404, [
      conflict("variant_missing", `Variant ${variantSku} no longer exists`, { variantSku }),
    ]);
  }
  if (product.status !== PRODUCT_STATUS.ACTIVE) {
    throw new AppError("Product not available", 409, [
      conflict("product_inactive", "Product is not active", { productId, variantSku }),
    ]);
  }
  if (!variant.product || variant.product.toString() !== product._id.toString()) {
    throw new AppError("Product and variant mismatch", 409, [
      conflict("ownership_mismatch", "Variant does not belong to product", {
        productId,
        variantSku,
      }),
    ]);
  }

  return { product, variant };
};

const isRetryableCartWrite = (error) => (
  error instanceof mongoose.Error.VersionError || error?.code === 11000
);

const mutateCartWithRetry = async (userId, mutate) => {
  for (let attempt = 0; attempt < CART_WRITE_RETRIES; attempt += 1) {
    const cart = await Cart.findOne({ userId }) || new Cart({ userId, items: [] });
    await mutate(cart);

    try {
      await cart.save();
      return cart;
    } catch (error) {
      if (!isRetryableCartWrite(error) || attempt === CART_WRITE_RETRIES - 1) throw error;
    }
  }

  throw new AppError("Cart changed concurrently; please retry", 409, [
    conflict("cart_concurrent_update", "Cart changed concurrently; please retry"),
  ]);
};

/** Format a cart without exposing procurement or exact-stock fields. */
export const formatCartResponse = async (cart) => {
  if (!cart) return { items: [] };

  const skus = [...new Set(cart.items.map((item) => item.variantSku))];
  const productIds = [...new Set(cart.items.map((item) => item.productId.toString()))];
  const [variants, products] = await Promise.all([
    Variant.find({ sku: { $in: skus } }),
    Product.find({ _id: { $in: productIds } }),
  ]);
  const variantsBySku = new Map(variants.map((variant) => [variant.sku, variant]));
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));

  return {
    items: cart.items.map((item) => {
      const variant = variantsBySku.get(item.variantSku);
      const productId = item.productId.toString();
      const product = productsById.get(productId);
      const hasSnapshot = Number.isFinite(item.priceAtAdd);
      const currentPrice = Number.isFinite(variant?.price) ? variant.price : null;

      return {
        product: { id: productId, name: product?.name ?? null },
        productId,
        variant: { id: variant?._id?.toString() ?? null, sku: item.variantSku },
        variantId: variant?._id?.toString() ?? null,
        variantSku: item.variantSku,
        quantity: item.quantity,
        priceAtAdd: hasSnapshot ? item.priceAtAdd : null,
        price: currentPrice,
        currentPrice,
        priceChanged: hasSnapshot && currentPrice != null
          ? item.priceAtAdd !== currentPrice
          : null,
        availability: variant?.availability ?? "unavailable",
        canFulfillQuantity: Boolean(
          variant
          && variant.sourcing == null
          && Number.isFinite(variant.inStock)
          && variant.inStock >= item.quantity
        ),
      };
    }),
  };
};

export const getCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const cart = await Cart.findOne({ userId });

  res.status(200).json({ success: true, data: await formatCartResponse(cart) });
});

export const addItem = catchAsync(async (req, res) => {
  const { productId, variantSku, quantity } = req.body;
  const userId = req.user.id || req.user._id;
  const { variant } = await loadPurchasableVariant({ productId, variantSku });

  const cart = await mutateCartWithRetry(userId, async (candidate) => {
    const existing = candidate.items.find((item) => item.variantSku === variantSku);
    const resultingQuantity = (existing?.quantity ?? 0) + quantity;
    assertPurchasableInventory(variant, resultingQuantity);

    if (existing) {
      if (existing.productId.toString() !== productId) {
        throw new AppError("Product and variant mismatch", 409, [
          conflict("ownership_mismatch", "Existing cart line belongs to another product", {
            productId,
            variantSku,
          }),
        ]);
      }
      existing.quantity = resultingQuantity;
      existing.priceAtAdd = variant.price;
    } else {
      candidate.items.push({
        productId,
        variantSku,
        quantity: resultingQuantity,
        priceAtAdd: variant.price,
      });
    }
  });

  res.status(200).json({ success: true, data: await formatCartResponse(cart) });
});

export const setItemQuantity = catchAsync(async (req, res) => {
  const { variantSku } = req.params;
  const { quantity } = req.body;
  const userId = req.user.id || req.user._id;
  const existingCart = await Cart.findOne({ userId });
  const existingLine = existingCart?.items.find((item) => item.variantSku === variantSku);

  if (!existingLine) {
    throw new AppError("Cart item not found", 404, [
      conflict("cart_item_missing", `Cart item ${variantSku} was not found`, { variantSku }),
    ]);
  }

  const { variant } = await loadPurchasableVariant({
    productId: existingLine.productId.toString(),
    variantSku,
  });
  assertPurchasableInventory(variant, quantity);

  const cart = await mutateCartWithRetry(userId, async (candidate) => {
    const line = candidate.items.find((item) => item.variantSku === variantSku);
    if (!line) {
      throw new AppError("Cart item not found", 404, [
        conflict("cart_item_missing", `Cart item ${variantSku} was not found`, { variantSku }),
      ]);
    }
    line.quantity = quantity;
    line.priceAtAdd = variant.price;
  });

  res.status(200).json({ success: true, data: await formatCartResponse(cart) });
});

export const removeItem = catchAsync(async (req, res) => {
  const { variantSku } = req.params;
  const userId = req.user.id || req.user._id;
  const cart = await Cart.findOneAndUpdate(
    { userId },
    { $pull: { items: { variantSku } } },
    { new: true, runValidators: true },
  );

  res.status(200).json({ success: true, data: await formatCartResponse(cart) });
});

const consolidateGuestItems = (guestItems) => {
  const consolidated = new Map();

  for (const item of guestItems) {
    const key = item.variantId;
    const current = consolidated.get(key) ?? {
      variantId: key,
      quantity: 0,
      expectedPrices: [],
    };
    current.quantity += item.quantity;
    if (item.price !== undefined) current.expectedPrices.push(item.price);
    consolidated.set(key, current);
  }

  return [...consolidated.values()].sort((left, right) => (
    left.variantId.localeCompare(right.variantId)
  ));
};

const mergeCartInTransaction = async (userId, guestItems) => {
  const session = await mongoose.startSession();
  let mergedCart;

  try {
    await session.withTransaction(async () => {
      const consolidated = consolidateGuestItems(guestItems);
      const variantIds = consolidated.map((item) => item.variantId);
      const variants = await Variant.find({ _id: { $in: variantIds } }).session(session);
      const variantsById = new Map(variants.map((variant) => [variant._id.toString(), variant]));
      const productIds = [...new Set(variants.map((variant) => variant.product?.toString()).filter(Boolean))];
      const products = await Product.find({ _id: { $in: productIds } }).session(session);
      const productsById = new Map(products.map((product) => [product._id.toString(), product]));
      const cart = await Cart.findOne({ userId }).session(session)
        || new Cart({ userId, items: [] });
      const conflicts = [];
      const resolved = [];

      for (const guestItem of consolidated) {
        const variant = variantsById.get(guestItem.variantId);
        if (!variant) {
          conflicts.push(conflict("variant_missing", "Guest variant no longer exists", {
            variantId: guestItem.variantId,
          }));
          continue;
        }

        const productId = variant.product?.toString();
        const product = productId ? productsById.get(productId) : null;
        if (!product) {
          conflicts.push(conflict("product_missing", "Variant product no longer exists", {
            variantId: guestItem.variantId,
            variantSku: variant.sku,
          }));
          continue;
        }
        if (product.status !== PRODUCT_STATUS.ACTIVE) {
          conflicts.push(conflict("product_inactive", "Product is not active", {
            productId,
            variantId: guestItem.variantId,
            variantSku: variant.sku,
          }));
        }

        const existing = cart.items.find((line) => line.variantSku === variant.sku);
        if (existing && existing.productId.toString() !== productId) {
          conflicts.push(conflict("ownership_mismatch", "Cart product and variant do not match", {
            productId: existing.productId.toString(),
            variantId: guestItem.variantId,
            variantSku: variant.sku,
          }));
        }

        const resultingQuantity = (existing?.quantity ?? 0) + guestItem.quantity;
        try {
          assertLocalInventory(variant, resultingQuantity);
        } catch (error) {
          conflicts.push(inventoryConflict(variant, resultingQuantity, error));
        }

        const staleExpectedPrice = guestItem.expectedPrices.find((price) => price !== variant.price);
        if (staleExpectedPrice !== undefined) {
          conflicts.push(conflict("price_changed", `Price of ${variant.sku} has changed`, {
            variantId: guestItem.variantId,
            variantSku: variant.sku,
            oldPrice: staleExpectedPrice,
            newPrice: variant.price,
          }));
        }

        resolved.push({ guestItem, variant, product, existing, resultingQuantity });
      }

      if (conflicts.length > 0) {
        throw new AppError("Some guest cart items cannot be merged", 409, conflicts);
      }

      for (const { variant, product, existing, resultingQuantity } of resolved) {
        if (existing) {
          existing.quantity = resultingQuantity;
          existing.priceAtAdd = variant.price;
        } else {
          cart.items.push({
            productId: product._id,
            variantSku: variant.sku,
            quantity: resultingQuantity,
            priceAtAdd: variant.price,
          });
        }
      }

      await cart.save({ session });
      mergedCart = cart;
    });
  } finally {
    await session.endSession();
  }

  return mergedCart;
};

export const mergeCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const cart = await mergeCartInTransaction(userId, req.body.guestItems);

  res.status(200).json({ success: true, data: await formatCartResponse(cart) });
});
