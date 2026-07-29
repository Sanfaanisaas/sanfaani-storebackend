import { z } from "zod";

export const getOrdersQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});

export const checkEligiblePickupSchema = z.object({
  total: z.preprocess((val) => parseFloat(val), z.number().min(0)),
  shippingAddress: z.preprocess((val) => {
    try {
      return typeof val === 'string' ? JSON.parse(val) : val;
    } catch {
      return val;
    }
  }, z.object({
    city: z.string().min(1),
  }).passthrough()),
});
