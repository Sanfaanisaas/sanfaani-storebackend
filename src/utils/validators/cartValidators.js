import { z } from "zod";
import mongoose from "mongoose";

const objectIdSchema = z.string().refine((val) => mongoose.Types.ObjectId.isValid(val), {
  message: "Invalid ObjectId",
});

export const addItemSchema = z.object({
  productId: objectIdSchema,
  variantSku: z.string().trim().min(1, "Variant SKU is required").max(200),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
}).strict();

export const setItemQuantitySchema = z.object({
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
}).strict();

export const mergeSchema = z.object({
  guestItems: z.array(z.object({
    variantId: objectIdSchema,
    quantity: z.number().int().min(1),
    // The current frontend omits this field. Older clients may send their
    // local display price; it is only an expected snapshot, never authority.
    price: z.number().finite().min(0).optional(),
  }).strict()).min(1).max(100),
}).strict();
