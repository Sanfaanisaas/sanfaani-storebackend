import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const guidanceIdParamSchema = z.object({
  id: objectIdSchema,
});

export const escalationIdParamSchema = z.object({
  id: objectIdSchema,
});

export const createGuidanceSchema = z.object({
  budget: z.preprocess(
    (val) => (val !== undefined && val !== null ? Number(val) : null),
    z.number().int({ message: "Budget must be an integer minor-unit amount" }).min(0, "Budget must be non-negative").nullable()
  ).optional(),
  useCase: z.string().trim().max(120).optional().nullable(),
  brands: z.array(z.string().trim().max(120)).max(10).optional(),
  categories: z.array(z.string().trim().max(120)).max(10).optional(),
  requiredFeatures: z.array(z.string().trim().max(120)).max(20).optional(),
});

export const createGuidanceEscalationSchema = z.object({
  question: z.string().trim().min(3, "Question must be at least 3 characters").max(1000, "Question cannot exceed 1000 characters"),
});

export const respondGuidanceEscalationSchema = z.object({
  response: z.string().trim().min(1, "Response body is required").max(2000),
  displayName: z.string().trim().max(120).optional().nullable(),
});

export const getGuidanceQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
