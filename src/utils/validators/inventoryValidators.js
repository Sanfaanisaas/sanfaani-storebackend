import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "A valid identifier is required");
const idempotencyKey = z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const reason = z.string().trim().min(3).max(500);

export const inventoryUnitParamSchema = z.object({ id: objectId });
export const discrepancyParamSchema = z.object({ id: objectId });

export const manualStockMovementSchema = z.object({
  variantId: objectId,
  delta: z.number().int().safe().refine((value) => value !== 0, "Delta cannot be zero"),
  reason: z.enum(["adjustment", "damage", "return"]),
  note: reason,
  evidenceId: objectId,
  idempotencyKey,
}).superRefine((body, context) => {
  if (body.reason === "damage" && body.delta > 0)
    context.addIssue({ code: "custom", path: ["delta"], message: "Damage must reduce stock" });
  if (body.reason === "return" && body.delta < 0)
    context.addIssue({ code: "custom", path: ["delta"], message: "Return must increase stock" });
});

export const transferInventoryUnitSchema = z.object({
  toLocationId: objectId,
  reason,
  evidenceId: objectId,
  idempotencyKey,
});

export const releaseInventoryUnitSchema = z.object({
  reason,
  evidenceId: objectId,
  idempotencyKey,
});

export const createStockCountSchema = z.object({
  variantId: objectId,
  locationId: objectId,
  countedQuantity: z.number().int().safe().min(0),
  reason,
  evidenceId: objectId,
  idempotencyKey,
});

export const resolveStockDiscrepancySchema = z.object({
  resolution: z.enum(["ADJUST_STOCK", "ACCEPT_NO_CHANGE"]),
  resolutionReason: reason,
  evidenceId: objectId,
  idempotencyKey,
});

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const stockCountQuerySchema = z.object({
  ...pagination,
  status: z.enum(["MATCHED", "DISCREPANCY", "RECONCILED"]).optional(),
});
export const stockDiscrepancyQuerySchema = z.object({
  ...pagination,
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
});
