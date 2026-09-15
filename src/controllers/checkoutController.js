import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import Cart from "../models/Cart.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { isPayOnPickupEligible } from "../services/orderService.js";
import { createReservation, RESERVATION_TTL_MS } from "../services/reservationService.js";
import { ORDER_STATUS, PRODUCT_STATUS } from "../utils/constants.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
let checkoutTestHooks = {};

// Tests use this to force a failure after a real reservation. Production never
// sets the hook, and no HTTP input can activate it.
export const setCheckoutTestHooks = (hooks = {}) => {
  checkoutTestHooks = hooks;
};

const conflict = (type, message, details = {}) => ({ type, message, ...details });

const normalizeText = (value, { uppercase = false } = {}) => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return uppercase ? normalized.toUpperCase() : normalized;
};

export const normalizeCheckoutRequest = ({ shippingAddress, paymentMethod }) => ({
  shippingAddress: {
    street: normalizeText(shippingAddress.street),
    city: normalizeText(shippingAddress.city),
    state: normalizeText(shippingAddress.state),
    postalCode: normalizeText(shippingAddress.postalCode || ""),
    country: normalizeText(shippingAddress.country, { uppercase: true }),
  },
  paymentMethod,
});

export const fingerprintCheckoutRequest = (request) => createHash("sha256")
  .update(JSON.stringify(normalizeCheckoutRequest(request)))
  .digest("hex");

const normalizeIdempotencyKey = (headerValue) => {
  if (typeof headerValue !== "string" || !headerValue.trim()) {
    throw new AppError("Idempotency-Key header is required", 400, [
      conflict("idempotency_key_required", "Provide a non-empty Idempotency-Key header"),
    ]);
  }

  const key = headerValue.trim();
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x21-\x7E]+$/.test(key)) {
    throw new AppError("Invalid Idempotency-Key header", 400, [
      conflict(
        "idempotency_key_invalid",
        `Idempotency-Key must contain 1-${IDEMPOTENCY_KEY_MAX_LENGTH} visible ASCII characters`,
      ),
    ]);
  }
  return key;
};

const assertFingerprintMatches = (order, fingerprint) => {
  if (order.requestFingerprint !== fingerprint) {
    throw new AppError("Idempotency-Key was already used for another request", 409, [
      conflict(
        "idempotency_key_reused",
        "Use a new Idempotency-Key when shipping address or payment method changes",
      ),
    ]);
  }
};

const collectCheckoutPreflight = async (cart, session) => {
  const conflicts = [];
  const resolvedItems = [];

  for (const item of cart.items) {
    const [product, variant] = await Promise.all([
      Product.findById(item.productId).session(session),
      Variant.findOne({ sku: item.variantSku }).session(session),
    ]);
    const base = {
      productId: item.productId.toString(),
      variantSku: item.variantSku,
    };

    if (!product) {
      conflicts.push(conflict("product_missing", "Product no longer exists", base));
    } else if (product.status !== PRODUCT_STATUS.ACTIVE) {
      conflicts.push(conflict("product_inactive", "Product is not active", base));
    }

    if (!variant) {
      conflicts.push(conflict("variant_missing", "Variant no longer exists", base));
    }

    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      conflicts.push(conflict("invalid_quantity", "Cart quantity must be a positive integer", {
        ...base,
        quantity: item.quantity,
      }));
    }

    if (!product || !variant) continue;

    if (!variant.product || variant.product.toString() !== product._id.toString()) {
      conflicts.push(conflict("ownership_mismatch", "Product and variant do not match", base));
    }

    if (variant.sourcing != null) {
      conflicts.push(conflict("sourcing_unavailable", "Sourcing-only variants cannot be checked out", base));
    } else if (!Number.isFinite(variant.inStock) || variant.inStock < 0) {
      conflicts.push(conflict("invalid_stock", "Variant has invalid local inventory", base));
    } else if (Number.isInteger(item.quantity) && item.quantity > variant.inStock) {
      conflicts.push(conflict("insufficient_stock", "Insufficient stock for cart quantity", {
        ...base,
        requestedQuantity: item.quantity,
        availableStock: variant.inStock,
      }));
    }

    if (!Number.isFinite(item.priceAtAdd)) {
      conflicts.push(conflict(
        "price_confirmation_required",
        "Legacy cart price must be confirmed before checkout",
        { ...base, newPrice: variant.price },
      ));
    } else if (item.priceAtAdd !== variant.price) {
      conflicts.push(conflict("price_changed", "Variant price has changed", {
        ...base,
        oldPrice: item.priceAtAdd,
        newPrice: variant.price,
      }));
    }

    resolvedItems.push({ item, product, variant });
  }

  return { conflicts, resolvedItems };
};

const isIdempotencyDuplicate = (error) => (
  error?.code === 11000
  && (error.keyPattern?.idempotencyKey || error.keyValue?.idempotencyKey)
);

const findReplayAfterCollision = async ({ userId, idempotencyKey, fingerprint }) => {
  const order = await Order.findOne({ userId, idempotencyKey });
  if (!order) return null;
  assertFingerprintMatches(order, fingerprint);
  return order;
};

export const createCheckout = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const idempotencyKey = normalizeIdempotencyKey(req.get("Idempotency-Key"));
  const normalizedRequest = normalizeCheckoutRequest(req.body);
  const fingerprint = fingerprintCheckoutRequest(normalizedRequest);
  const { shippingAddress, paymentMethod } = normalizedRequest;
  const session = await mongoose.startSession();
  let createdOrder;
  let replayed = false;

  try {
    try {
      await session.withTransaction(async () => {
        createdOrder = undefined;
        replayed = false;

        const existingOrder = await Order.findOne({ userId, idempotencyKey }).session(session);
        if (existingOrder) {
          assertFingerprintMatches(existingOrder, fingerprint);
          createdOrder = existingOrder;
          replayed = true;
          return;
        }

        const cart = await Cart.findOne({ userId }).session(session);
        if (!cart || cart.items.length === 0) {
          throw new AppError("Cart is empty", 400, [
            conflict("cart_empty", "Add at least one item before checkout"),
          ]);
        }

        const { conflicts, resolvedItems } = await collectCheckoutPreflight(cart, session);
        if (conflicts.length > 0) {
          throw new AppError("Some items in your cart have changed", 409, conflicts);
        }

        const orderItems = [];
        let orderSubtotal = 0;

        for (const { item, product, variant } of resolvedItems) {
          orderItems.push({
            productId: item.productId,
            variantSku: item.variantSku,
            nameSnapshot: `${product.name} (${variant.sku})`,
            priceSnapshot: variant.price,
            quantity: item.quantity,
          });
          orderSubtotal += item.quantity * variant.price;
        }

        const tax = 0;
        const shippingCost = 0;
        const total = orderSubtotal + tax + shippingCost;

        if (paymentMethod === "pay_on_pickup" && !isPayOnPickupEligible({
          total,
          shippingAddress,
        })) {
          throw new AppError(
            "Order not eligible for pay-on-pickup based on location or total amount",
            400,
          );
        }

        [createdOrder] = await Order.create(
          [{
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
            idempotencyKey,
            requestFingerprint: fingerprint,
            payOnPickupExpiresAt:
              paymentMethod === "pay_on_pickup"
                ? new Date(Date.now() + RESERVATION_TTL_MS)
                : null,
          }],
          { session },
        );

        for (let index = 0; index < resolvedItems.length; index += 1) {
          const { item, product, variant } = resolvedItems[index];
          try {
            await createReservation({ order: createdOrder._id, product: product._id, variant: variant._id, quantity: item.quantity, actorId: userId, session });
          } catch (error) {
            if (error.statusCode === 409) {
              throw new AppError("Inventory changed during checkout", 409, [
                conflict("insufficient_stock", "Stock changed while checkout was being committed", {
                  productId: item.productId.toString(), variantSku: item.variantSku, requestedQuantity: item.quantity,
                }),
              ]);
            }
            throw error;
          }
          if (checkoutTestHooks.afterReservation) await checkoutTestHooks.afterReservation({ index, item, variant, order: createdOrder, session });
        }

        await Cart.deleteOne({ _id: cart._id, userId }, { session });
      });
    } catch (error) {
      if (!isIdempotencyDuplicate(error)) throw error;
      createdOrder = await findReplayAfterCollision({ userId, idempotencyKey, fingerprint });
      if (!createdOrder) {
        throw new AppError("Checkout is already being processed", 409, [
          conflict("idempotency_in_progress", "Retry the same request shortly"),
        ]);
      }
      replayed = true;
    }

    if (replayed) res.set("Idempotency-Replayed", "true");
    res.status(replayed ? 200 : 201).json({
      success: true,
      data: createdOrder.toPublicOrder(),
    });
  } finally {
    await session.endSession();
  }
});
