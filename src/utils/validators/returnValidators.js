import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const returnOrderIdParamSchema = z.object({
  orderId: objectIdSchema,
});

export const returnIdParamSchema = z.object({
  id: objectIdSchema,
});

export const createReturnSchema = z.object({
  items: z.array(
    z.object({
      variantSku: z.string().trim().min(1, "Variant SKU is required"),
      quantity: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1, "Quantity must be at least 1")),
    })
  ).min(1, "At least one item must be specified"),
  reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500, "Reason cannot exceed 500 characters"),
});

export const decideReturnSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "INSPECTION_REQUIRED", "UNDER_INSPECTION", "REMEDY_IN_PROGRESS", "RESOLVED", "CANCELLED"], {
    errorMap: () => ({ message: "Invalid return status decision" }),
  }),
  remedy: z.enum(["repair", "replacement", "refund", "store_credit"]).optional().nullable(),
  privateNotes: z.string().trim().max(2000).optional().nullable(),
  nextAction: z.string().trim().max(500).optional().nullable(),
  acceptedQuantities: z.record(z.string(), z.preprocess((val) => parseInt(val, 10), z.number().int().min(0))).optional(),
});

export const getReturnsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
