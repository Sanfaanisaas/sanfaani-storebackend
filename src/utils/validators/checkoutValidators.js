import { z } from "zod";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId");

export const checkoutSchema = z.object({
  shippingAddress: z.object({
    street: z.string().trim().min(1).max(300),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().max(40).optional().or(z.literal("")),
    country: z.string().trim().min(1).max(120),
  }).strict(),
  paymentMethod: z.enum(["paystack", "bank_transfer", "pay_on_pickup"]),
}).strict();
