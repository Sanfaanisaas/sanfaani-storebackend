import { z } from "zod";
import { PRODUCT_STATUS, PRODUCT_CONDITION } from "../constants.js";

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  slug: z.string().trim().min(1, "Slug is required").regex(/^[a-z0-9-]+$/, "Slug must be URL-safe"),
  description: z.string().trim().min(1, "Description is required"),
  category: z.string().trim().min(1, "Category is required"),
  brand: z.string().trim().min(1, "Brand is required"),
  images: z.array(z.string().trim()).optional(),
  status: z.nativeEnum(PRODUCT_STATUS).optional(),
  tags: z.array(z.string().trim()).optional(),
  isFeatured: z.boolean().optional(),
  displayOrder: z.number().optional(),
  seo: z.object({
    title: z.string().trim().optional(),
    description: z.string().trim().optional()
  }).optional()
});

export const updateProductSchema = createProductSchema.partial();

export const createVariantSchema = z.object({
  product: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid product ID"),
  sku: z.string().trim().min(1, "SKU is required"),
  attributes: z.record(z.any()),
  price: z.number().min(0, "Price must be non-negative"),
  condition: z.nativeEnum(PRODUCT_CONDITION),
  inspectionSummary: z.string().trim().optional(),
  limitations: z.string().trim().optional(),
  conditionEvidence: z.array(z.string().trim()).optional(),
  warrantyTerms: z.string().trim().optional(),
  inStock: z.number().min(0).optional(),
  sourcing: z.object({
    supplier: z.string().min(1),
    leadTimeDays: z.number().min(0),
    costPrice: z.number().min(0),
  }).optional(),
}).refine(data => (data.inStock != null) !== (data.sourcing != null), {
  message: "Exactly one of inStock or sourcing must be provided"
});

export const updateVariantSchema = createVariantSchema.omit({ product: true }).partial();
