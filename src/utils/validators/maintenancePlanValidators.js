import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const maintenancePlanIdParamSchema = z.object({
  id: objectIdSchema,
});

export const getMaintenancePlansQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});

const expectedVersion = z.preprocess((value) => Number(value), z.number().int().min(0));
const date = z.preprocess((value) => new Date(value), z.date());
const strings = z.array(z.string().trim().min(1).max(300)).max(50);

export const createMaintenancePlanSchema = z.object({
  customerId: objectIdSchema,
  scope: z.string().trim().min(3).max(1500),
  coveredDevices: strings.optional(),
  includedServices: strings.min(1),
  frequency: z.string().trim().min(1).max(120),
  startDate: date,
  renewalDate: date.optional().nullable(),
  renewalModel: z.enum(["manual_renewal", "fixed_term"]),
  visitLimits: z.string().trim().max(500).optional().nullable(),
  exclusions: strings.optional(),
  price: z.preprocess((value) => Number(value), z.number().int().min(0)),
  currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
  termsVersion: z.string().trim().min(1).max(64),
  cancellationInstructions: z.string().trim().min(3).max(1000),
}).strict().refine((value) => !value.renewalDate || value.renewalDate > value.startDate, { message: "Renewal date must be after start date", path: ["renewalDate"] });

export const updateMaintenancePlanSchema = z.object({
  expectedVersion,
  scope: z.string().trim().min(3).max(1500).optional(),
  coveredDevices: strings.optional(),
  includedServices: strings.min(1).optional(),
  frequency: z.string().trim().min(1).max(120).optional(),
  renewalDate: date.optional().nullable(),
  visitLimits: z.string().trim().max(500).optional().nullable(),
  exclusions: strings.optional(),
  cancellationInstructions: z.string().trim().min(3).max(1000).optional(),
}).strict();

export const cancelMaintenancePlanSchema = z.object({ expectedVersion, reason: z.string().trim().min(3).max(500) }).strict();

export const renewMaintenancePlanSchema = z.object({
  expectedVersion,
  startDate: date,
  renewalDate: date.optional().nullable(),
  price: z.preprocess((value) => Number(value), z.number().int().min(0)),
  termsVersion: z.string().trim().min(1).max(64),
}).strict().refine((value) => !value.renewalDate || value.renewalDate > value.startDate, { message: "Renewal date must be after start date", path: ["renewalDate"] });
