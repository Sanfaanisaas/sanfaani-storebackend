import { z } from "zod";
import { PRODUCT_CONDITION, PRODUCT_STATUS } from "../constants.js";
import { normalizeSlug } from "../../services/catalogueValidationService.js";

const requiredText = (message) => z.string().trim().min(1, message);
const slugSchema = requiredText("Slug is required")
  .transform(normalizeSlug)
  .refine((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), {
    message: "Slug must contain URL-safe text",
  });

const productShape = {
  name: requiredText("Product name is required").optional(),
  slug: slugSchema.optional(),
  description: requiredText("Description is required").optional(),
  category: requiredText("Category is required").optional(),
  brand: requiredText("Brand is required").optional(),
  images: z.array(requiredText("Image URL cannot be empty")).optional(),
  status: z.enum(Object.values(PRODUCT_STATUS)).optional(),
  tags: z.array(z.string().trim()).optional(),
  isFeatured: z.boolean().optional(),
  displayOrder: z.number().finite().optional(),
  seo: z.object({
    title: z.string().trim().optional(),
    description: z.string().trim().optional(),
  }).optional(),
};

export const createProductSchema = z.object(productShape).superRefine((data, ctx) => {
  if (data.status === PRODUCT_STATUS.ACTIVE) return;

  for (const [field, label] of [
    ["name", "Product name"],
    ["slug", "Slug"],
    ["description", "Description"],
    ["category", "Category"],
    ["brand", "Brand"],
  ]) {
    if (data[field] == null) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${label} is required`,
      });
    }
  }
});

export const updateProductSchema = z.object(productShape);

const inspectionSchema = z.object({
  summary: requiredText("Inspection summary is required"),
  inspectedAt: z.union([z.iso.datetime(), z.date()]).optional(),
  inspector: z.string().trim().optional(),
});

const conditionEvidenceSchema = z.object({
  url: z.url("Invalid condition-evidence URL"),
  alt: z.string().trim().optional(),
});

const warrantySchema = z.object({
  version: requiredText("Warranty version is required")
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Warranty version is invalid"),
  terms: requiredText("Warranty terms are required"),
});

const sourcingSchema = z.object({
  supplier: requiredText("Supplier is required"),
  leadTimeDays: z.number().finite().min(0),
  costPrice: z.number().finite().min(0),
});

const variantShape = {
  product: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid product ID"),
  sku: requiredText("SKU is required"),
  attributes: z.record(z.string(), z.unknown()),
  price: z.number().finite().min(0, "Price must be non-negative"),
  condition: z.enum(Object.values(PRODUCT_CONDITION)),
  inspection: inspectionSchema.optional(),
  limitations: z.string().trim().optional(),
  conditionEvidence: z.array(conditionEvidenceSchema).optional(),
  warranty: warrantySchema.optional(),
  inStock: z.number().finite().min(0).optional(),
  sourcing: sourcingSchema.optional(),
};

export const createVariantSchema = z.object(variantShape);

export const createVariantSchemaWithRefinement = createVariantSchema.refine(
  (data) => (data.inStock != null) !== (data.sourcing != null),
  {
    path: ["inventoryMode"],
    message: "Exactly one of inStock or sourcing must be provided",
  },
);

export const updateVariantSchema = z.object({
  ...Object.fromEntries(
    Object.entries(variantShape).map(([key, schema]) => [key, schema.optional()]),
  ),
});
