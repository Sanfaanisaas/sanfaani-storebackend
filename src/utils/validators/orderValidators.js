import { z } from "zod";

export const getOrdersQuerySchema = z.object({
  page: z
    .preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1))
    .optional(),
  limit: z
    .preprocess(
      (val) => parseInt(val, 10),
      z.number().int().min(1).max(50).default(20),
    )
    .optional(),
});

export const checkEligiblePickupSchema = z.object({
  orderId: z.string().regex(/^[a-f\d]{24}$/i),
});

export const getOrdersQueueQuerySchema = z.object({
  page: z
    .preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1))
    .optional(),
  limit: z
    .preprocess(
      (val) => parseInt(val, 10),
      z.number().int().min(1).max(100).default(20),
    )
    .optional(),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
});

export const dispatchOrderSchema = z.object({
  trackingReference: z.string().trim().min(1).optional(),
  courierName: z.string().trim().min(1).optional(),
  assignedSerials: z.array(z.string().trim()).optional(),
}).default({});

export const collectOrderSchema = z.object({
  identityDocumentType: z.enum([
    "ID_CARD",
    "PASSPORT",
    "DRIVERS_LICENSE",
    "OTHER",
  ]),
  acknowledgedBy: z.string().trim().min(2),
  assignedSerials: z.array(z.string().trim()).optional(),
});
