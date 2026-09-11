import { z } from "zod";
import { CLAIM_STATUS } from "../constants.js";

export const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const claimIdParamSchema = z.object({
  id: objectIdSchema,
});

export const warrantyClaimParamsSchema = z.object({
  id: objectIdSchema,
});

export const createClaimSchema = z.object({
  description: z.string().trim().min(3, "Description must be at least 3 characters").max(4000, "Description cannot exceed 4000 characters"),
});

export const updateClaimStatusSchema = z.object({
  status: z.enum(Object.values(CLAIM_STATUS), {
    errorMap: () => ({ message: "Invalid claim status" }),
  }),
  customerSafeReason: z.string().trim().max(1000).optional().nullable(),
  nextAction: z.string().trim().max(500).optional().nullable(),
  informationRequests: z.array(
    z.object({
      message: z.string().trim().min(1, "Message is required").max(1000),
      dueAt: z.preprocess((val) => (val ? new Date(val) : null), z.date().optional().nullable()),
    })
  ).optional(),
  remedy: z.object({
    type: z.enum(["repair", "replacement", "refund", "store_credit"]),
    summary: z.string().trim().min(1, "Summary is required").max(1500),
    outcome: z.string().trim().max(1500).optional().nullable(),
  }).optional().nullable(),
});

export const getClaimsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
