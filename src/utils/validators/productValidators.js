import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  slug: z.string().trim().min(1, "Slug is required"),
  description: z.string().trim().optional(),
  category: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  images: z.array(z.string().trim()).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const createVariantSchema = z.object({
  product: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid product ID"),
  sku: z.string().trim().min(1, "SKU is required"),
  attributes: z.record(z.any()),
  price: z.number().min(0, "Price must be non-negative"),
  condition: z.string().min(1, "Condition is required"),
  inStock: z.number().min(0).optional(),
  sourcing: z.object({
    supplier: z.string().min(1),
    leadTimeDays: z.number().min(0),
    costPrice: z.number().min(0),
  }).optional(),
});

export const updateVariantSchema = createVariantSchema.omit({ product: true }).partial();
