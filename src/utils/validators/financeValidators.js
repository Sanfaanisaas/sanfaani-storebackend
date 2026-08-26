import { z } from "zod";
export const paymentIdSchema = z.object({ paymentId: z.string().regex(/^[a-fA-F0-9]{24}$/) });
export const refundSchema = z.object({ amount: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), reason: z.string().trim().min(3).max(500) }).strict();
export const reconciliationResolutionSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const repairIdParamSchema = z.object({ repairId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict();
export const financeOverrideIdParamSchema = z.object({ overrideId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict();
export const createFinanceOverrideSchema = z.object({
  scope: z.enum(["ALL", "WORK_START", "QC", "READY", "HANDOVER"]).default("ALL"),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const revokeFinanceOverrideSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
