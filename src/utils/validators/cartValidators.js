import { z } from "zod";
import mongoose from "mongoose";

const objectIdSchema = z.string().refine((val) => mongoose.Types.ObjectId.isValid(val), {
  message: "Invalid ObjectId",
});

export const addItemSchema = z.object({
  productId: objectIdSchema,
  variantSku: z.string().min(1, "Variant SKU is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
});

export const mergeSchema = z.object({
  guestId: z.string().min(1, "Guest ID is required"),
});
