import { z } from "zod";

export const initiatePaymentSchema = z.object({
  orderId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid orderId format"),
  email: z.string().email().optional(),
});
