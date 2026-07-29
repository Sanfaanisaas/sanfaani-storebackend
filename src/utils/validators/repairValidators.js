import { z } from "zod";

export const createRepairSchema = z.object({
  device: z.object({
    type: z.string().trim().min(1, "Device type is required"),
    brand: z.string().trim().min(1, "Brand is required"),
    model: z.string().trim().min(1, "Model is required"),
    serialNumber: z.string().trim().optional(),
  }),
  issueDescription: z.string().trim().min(5, "Issue description must be at least 5 characters"),
  privacyAcknowledged: z.literal(true, {
    errorMap: () => ({ message: "You must acknowledge the privacy policy" }),
  }),
});

export const getRepairsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(100).default(20)).optional(),
  status: z.string().optional(),
  technician: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
});
