import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const procurementRequestIdParamSchema = z.object({
  id: objectIdSchema,
});

export const procurementClarificationParamSchema = z.object({
  id: objectIdSchema,
  clarificationId: objectIdSchema,
});

export const procurementQuotationIdParamSchema = z.object({
  id: objectIdSchema,
});

const requirementItemSchema = z.object({
  category: z.string().trim().min(1, "Category is required").max(120),
  quantity: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(10000)),
  minimumSpecifications: z.string().trim().min(1, "Minimum specifications are required").max(2000),
  preferredCondition: z.enum(["new", "refurbished", "either"]).optional().default("either"),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const createProcurementRequestSchema = z.object({
  organisationName: z.string().trim().min(1, "Organisation name is required").max(160),
  organisationType: z.enum(["business", "school", "nonprofit", "government", "other"]),
  contactName: z.string().trim().min(1, "Contact name is required").max(160),
  contactEmail: z.string().trim().email("Contact email must be valid").max(254),
  contactPhone: z.string().trim().min(1, "Contact phone is required").max(40),
  requirements: z.array(requirementItemSchema).min(1, "Provide between 1 and 25 requirements").max(25),
  budgetMin: z.preprocess((val) => (val !== undefined && val !== null ? Number(val) : null), z.number().int().min(0).nullable()).optional(),
  budgetMax: z.preprocess((val) => (val !== undefined && val !== null ? Number(val) : null), z.number().int().min(0).nullable()).optional(),
  requiredBy: z.preprocess((val) => (val ? new Date(val) : null), z.date().optional().nullable()),
  fulfilmentMode: z.enum(["delivery", "pickup", "either"]).optional().default("either"),
  fulfilmentLocation: z.string().trim().max(500).optional().nullable(),
  softwareAndLicensingNeeds: z.string().trim().max(2000).optional().nullable(),
  warrantyAndSupportNeeds: z.string().trim().max(2000).optional().nullable(),
  setupDeploymentNeeds: z.string().trim().max(2000).optional().nullable(),
  accessibilityNeeds: z.string().trim().max(2000).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
}).refine(
  (data) => data.budgetMin == null || data.budgetMax == null || data.budgetMin <= data.budgetMax,
  { message: "Budget maximum must be at least budget minimum", path: ["budgetMax"] }
);

export const patchProcurementRequestSchema = z.object({
  organisationName: z.string().trim().min(1).max(160).optional(),
  organisationType: z.enum(["business", "school", "nonprofit", "government", "other"]).optional(),
  contactName: z.string().trim().min(1).max(160).optional(),
  contactEmail: z.string().trim().email().max(254).optional(),
  contactPhone: z.string().trim().min(1).max(40).optional(),
  requirements: z.array(requirementItemSchema).min(1).max(25).optional(),
  budgetMin: z.preprocess((val) => (val !== undefined && val !== null ? Number(val) : null), z.number().int().min(0).nullable()).optional(),
  budgetMax: z.preprocess((val) => (val !== undefined && val !== null ? Number(val) : null), z.number().int().min(0).nullable()).optional(),
  requiredBy: z.preprocess((val) => (val ? new Date(val) : null), z.date().optional().nullable()),
  fulfilmentMode: z.enum(["delivery", "pickup", "either"]).optional(),
  fulfilmentLocation: z.string().trim().max(500).optional().nullable(),
  softwareAndLicensingNeeds: z.string().trim().max(2000).optional().nullable(),
  warrantyAndSupportNeeds: z.string().trim().max(2000).optional().nullable(),
  setupDeploymentNeeds: z.string().trim().max(2000).optional().nullable(),
  accessibilityNeeds: z.string().trim().max(2000).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
});

export const respondProcurementClarificationSchema = z.object({
  response: z.string().trim().min(1, "Clarification response is required").max(1000),
});

export const decideProcurementQuotationSchema = z.object({
  version: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1, "Quotation version is required")),
});

export const createStaffProcurementQuotationSchema = z.object({
  lineItems: z.array(
    z.object({
      description: z.string().trim().min(1, "Line item description is required").max(500),
      quantity: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1)),
      unitPrice: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
      totalAmount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
    })
  ).min(1, "Quotation requires line items"),
  subtotal: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
  tax: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
  fees: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
  fulfilmentCharge: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
  totalAmount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
  validUntil: z.preprocess((val) => new Date(val), z.date()),
  termsVersion: z.string().trim().min(1).max(64),
  warrantySummary: z.string().trim().max(1500).optional().nullable(),
  supportSummary: z.string().trim().max(1500).optional().nullable(),
  documentEvidence: objectIdSchema.optional().nullable(),
});

export const getProcurementRequestsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
