import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "A valid identifier is required");
const idempotencyKey = z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const reason = z.string().trim().min(3).max(500);

export const procurementIdParamSchema = z.object({ id: objectId });

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().min(5).max(64).optional(),
});

export const updateSupplierSchema = z.object({
  expectedVersion: z.number().int().min(0),
  name: z.string().trim().min(2).max(160).optional(),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  phone: z.string().trim().max(64).optional(),
}).refine((body) => body.name !== undefined || body.email !== undefined || body.phone !== undefined, {
  message: "At least one supplier field is required",
});

export const deactivateSupplierSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason,
});

const purchaseOrderLine = z.object({
  variant: objectId,
  quantity: z.number().int().safe().min(1).max(100000),
  unitCost: z.number().int().safe().min(0),
});
export const createPurchaseOrderSchema = z.object({
  supplier: objectId,
  lines: z.array(purchaseOrderLine).min(1).max(100),
  idempotencyKey,
});
export const purchaseOrderReasonSchema = z.object({ reason });
export const receivePurchaseOrderSchema = z.object({
  variantId: objectId,
  quantity: z.number().int().safe().min(1).max(100000),
  locationId: objectId,
  serials: z.array(z.string().trim().min(1).max(128)).max(1000).default([]),
  condition: z.enum(["NEW", "REFURBISHED", "USED", "DAMAGED"]).default("NEW"),
  evidenceId: objectId,
  idempotencyKey,
});

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const supplierQuerySchema = z.object({
  ...pagination,
  active: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});
export const purchaseOrderQuerySchema = z.object({
  ...pagination,
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "RECEIVING", "CLOSED", "CANCELLED"]).optional(),
  supplier: objectId.optional(),
});
