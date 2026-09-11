/**
 * Customer Operations Module
 * 
 * Deep domain module encapsulating Cart management, Server-Authoritative Quotes,
 * Order Checkout, Payments, Claims, Warranties, and Return Processing.
 * 
 * Exposes a clean Command/Query interface. Hides persistence queries,
 * validation invariants, inventory assertions, and transactional merges behind the seam.
 */

import mongoose from "mongoose";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import Claim from "../models/Claim.js";
import ReturnRequest from "../models/ReturnRequest.js";
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

export class CustomerOperationsModule {
  async loadPurchasableVariant({ productId, variantSku }) {
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
  }

  async formatCartResponse(cart) {
    if (!cart) return { items: [] };

    const skus = [...new Set(cart.items.map((item) => item.variantSku))];
    const productIds = [...new Set(cart.items.map((item) => item.productId.toString()))];
    const [variants, products] = await Promise.all([
      Variant.find({ sku: { $in: skus } }),
      Product.find({ _id: { $in: productIds } }),
    ]);
    const variantsBySku = new Map(variants.map((v) => [v.sku, v]));
    const productsById = new Map(products.map((p) => [p._id.toString(), p]));

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
            variant &&
            variant.sourcing == null &&
            Number.isFinite(variant.inStock) &&
            variant.inStock >= item.quantity
          ),
        };
      }),
    };
  }

  async getCart(userId) {
    const cart = await Cart.findOne({ userId });
    return this.formatCartResponse(cart);
  }

  async addItem(userId, { productId, variantSku, quantity }) {
    const { variant } = await this.loadPurchasableVariant({ productId, variantSku });

    const cart = await this.mutateCartWithRetry(userId, async (candidate) => {
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

    return this.formatCartResponse(cart);
  }

  async setItemQuantity(userId, variantSku, quantity) {
    const existingCart = await Cart.findOne({ userId });
    const existingLine = existingCart?.items.find((item) => item.variantSku === variantSku);

    if (!existingLine) {
      throw new AppError("Cart item not found", 404, [
        conflict("cart_item_missing", `Cart item ${variantSku} was not found`, { variantSku }),
      ]);
    }

    const { variant } = await this.loadPurchasableVariant({
      productId: existingLine.productId.toString(),
      variantSku,
    });
    assertPurchasableInventory(variant, quantity);

    const cart = await this.mutateCartWithRetry(userId, async (candidate) => {
      const line = candidate.items.find((item) => item.variantSku === variantSku);
      if (!line) {
        throw new AppError("Cart item not found", 404, [
          conflict("cart_item_missing", `Cart item ${variantSku} was not found`, { variantSku }),
        ]);
      }
      line.quantity = quantity;
      line.priceAtAdd = variant.price;
    });

    return this.formatCartResponse(cart);
  }

  async removeItem(userId, variantSku) {
    const cart = await Cart.findOneAndUpdate(
      { userId },
      { $pull: { items: { variantSku } } },
      { new: true, runValidators: true },
    );
    return this.formatCartResponse(cart);
  }

  async mergeCart(userId, guestItems) {
    const session = await mongoose.startSession();
    let mergedCart;

    try {
      await session.withTransaction(async () => {
        const consolidated = this.consolidateGuestItems(guestItems);
        const variantIds = consolidated.map((i) => i.variantId);
        const variants = await Variant.find({ _id: { $in: variantIds } }).session(session);
        const variantsById = new Map(variants.map((v) => [v._id.toString(), v]));
        const productIds = [...new Set(variants.map((v) => v.product?.toString()).filter(Boolean))];
        const products = await Product.find({ _id: { $in: productIds } }).session(session);
        const productsById = new Map(products.map((p) => [p._id.toString(), p]));
        const cart = await Cart.findOne({ userId }).session(session) || new Cart({ userId, items: [] });
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

          const staleExpectedPrice = guestItem.expectedPrices.find((p) => p !== variant.price);
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

    return this.formatCartResponse(mergedCart);
  }

  consolidateGuestItems(guestItems) {
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
  }

  async mutateCartWithRetry(userId, mutate) {
    for (let attempt = 0; attempt < CART_WRITE_RETRIES; attempt += 1) {
      const cart = await Cart.findOne({ userId }) || new Cart({ userId, items: [] });
      await mutate(cart);

      try {
        await cart.save();
        return cart;
      } catch (error) {
        const isRetryable = error instanceof mongoose.Error.VersionError || error?.code === 11000;
        if (!isRetryable || attempt === CART_WRITE_RETRIES - 1) throw error;
      }
    }

    throw new AppError("Cart changed concurrently; please retry", 409, [
      conflict("cart_concurrent_update", "Cart changed concurrently; please retry"),
    ]);
  }

  /** Order & Claim queries */
  async getOrderById(orderId, userId) {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError("Order not found", 404);
    if (userId && order.user && order.user.toString() !== userId.toString()) {
      throw new AppError("Access denied", 403);
    }
    return order;
  }

  async listUserClaims(userId) {
    return Claim.find({ user: userId }).sort({ createdAt: -1 });
  }

  async listUserReturns(userId) {
    return ReturnRequest.find({ user: userId }).sort({ createdAt: -1 });
  }
}

export const customerOpsModule = new CustomerOperationsModule();
export default customerOpsModule;
