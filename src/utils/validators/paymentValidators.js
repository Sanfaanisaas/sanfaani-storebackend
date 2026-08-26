import { z } from "zod";

export const initiatePaymentSchema = z.object({
  orderId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid orderId format"),
  email: z.string().email().optional(),
});

export const paymentAttemptSchema = z.discriminatedUnion("subjectType", [
  z.object({ subjectType: z.literal("order"), subjectId: z.string().regex(/^[0-9a-fA-F]{24}$/), email: z.string().email().optional() }).strict(),
  z.object({ subjectType: z.literal("repair"), subjectId: z.string().regex(/^[0-9a-fA-F]{24}$/), purpose: z.literal("repair_deposit"), email: z.string().email().optional() }).strict(),
]);
