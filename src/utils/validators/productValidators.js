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
  attributes: z.record(z.string()).optional(),
  price: z.number().min(0, "Price must be non-negative"),
  costPrice: z.number().min(0, "Cost price must be non-negative").optional(),
  supplier: z.object({
    name: z.string().trim().optional(),
    contact: z.string().trim().optional(),
  }).optional(),
  in_stock: z.boolean().optional(),
  stockQuantity: z.number().min(0, "Stock quantity must be non-negative").optional(),
  sourcing: z.boolean().optional(),
  sourcingLeadTimeDays: z.number().min(0, "Sourcing lead time must be non-negative").optional(),
});

export const updateVariantSchema = createVariantSchema.omit({ product: true }).partial();
