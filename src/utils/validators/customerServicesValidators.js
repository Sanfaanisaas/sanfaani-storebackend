import { z } from "zod";
import { SERVICE_TYPES } from "../../models/ServiceRequest.js";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const serviceRequestIdParamSchema = z.object({
  id: objectIdSchema,
});

export const serviceQuoteIdParamSchema = z.object({
  id: objectIdSchema,
});

export const createServiceRequestSchema = z.object({
  serviceType: z.enum(SERVICE_TYPES, {
    errorMap: () => ({ message: "Invalid service type" }),
  }),
  deviceCategory: z.string().trim().min(1, "Device category is required").max(120),
  brand: z.string().trim().max(120).optional().nullable(),
  model: z.string().trim().max(160).optional().nullable(),
  currentSpecifications: z.string().trim().max(2000).optional().nullable(),
  desiredOutcome: z.string().trim().min(3, "Desired outcome must be at least 3 characters").max(2000),
  softwareRequirements: z.string().trim().max(2000).optional().nullable(),
  dataMigrationRequired: z.boolean().optional().default(false),
  licenceOwnershipAcknowledgement: z.literal(true, {
    errorMap: () => ({ message: "Licence ownership acknowledgement is required" }),
  }),
  backupAcknowledgement: z.literal(true, {
    errorMap: () => ({ message: "Backup acknowledgement is required" }),
  }),
  fulfilmentPreference: z.enum(["onsite", "drop_off", "pickup", "remote_assessment"]).optional().default("drop_off"),
  timeConstraints: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
});

export const decideServiceQuoteSchema = z.object({
  version: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1, "Quotation version is required")),
});

export const recordStaffAssessmentSchema = z.object({
  result: z.enum(["COMPATIBLE", "PARTIALLY_COMPATIBLE", "INCOMPATIBLE"], {
    errorMap: () => ({ message: "Invalid assessment result" }),
  }),
  summary: z.string().trim().max(2000).optional().nullable(),
  assumptions: z.array(z.string().trim()).max(20).optional(),
  requirements: z.array(z.string().trim()).max(20).optional(),
  requiredParts: z.array(z.string().trim()).max(20).optional(),
  requiredSoftware: z.array(z.string().trim()).max(20).optional(),
  limitations: z.array(z.string().trim()).max(20).optional(),
  exclusions: z.array(z.string().trim()).max(20).optional(),
  customerResponsibilities: z.array(z.string().trim()).max(20).optional(),
  nextAction: z.string().trim().max(500).optional().nullable(),
});

export const createStaffServiceQuoteSchema = z.object({
  lineItems: z.array(
    z.object({
      description: z.string().trim().min(1, "Description is required").max(500),
      amount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
    })
  ).min(1, "Quote requires line items"),
  totalAmount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
  estimatedDays: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)),
  expiresAt: z.preprocess((val) => new Date(val), z.date()),
  depositRequirement: z.object({
    required: z.boolean().optional().default(false),
    amount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
    currency: z.string().regex(/^[A-Z]{3}$/).optional().default("NGN"),
    dueBeforeWork: z.boolean().optional().default(false),
  }).optional(),
  paymentState: z.object({
    status: z.enum(["not_required", "pending", "partially_confirmed", "confirmed", "failed"]).optional().default("not_required"),
    confirmedAmount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
    remainingAmount: z.preprocess((val) => parseInt(val, 10), z.number().int().min(0)).optional().default(0),
  }).optional(),
});

export const getServiceRequestsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
