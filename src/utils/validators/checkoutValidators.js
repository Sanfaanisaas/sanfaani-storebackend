import { z } from "zod";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId");

export const checkoutSchema = z.object({
  shippingAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().optional().or(z.literal("")),
    country: z.string().min(1),
  }),
  paymentMethod: z.enum(["paystack", "bank_transfer", "pay_on_pickup"]),
});
