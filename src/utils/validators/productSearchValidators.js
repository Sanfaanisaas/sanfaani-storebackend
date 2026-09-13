import { z } from "zod";

// Helper to safely coerce string queries to integers, handling empty strings safely
const coerceInt = z.preprocess((val) => {
  if (val === undefined || val === null || val === "") return undefined;
  const parsed = Number(val);
  return isNaN(parsed) ? undefined : Math.floor(parsed);
}, z.number().int().min(0).optional());

export const searchProductsSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(50).optional(),
    brand: z.string().trim().max(50).optional(),
    condition: z.string().optional(),
    availability: z.string().optional(),
    minPrice: coerceInt,
    maxPrice: coerceInt,
    sort: z.enum(["price_asc", "price_desc", "newest", "relevance"]).optional(),
    page: coerceInt,
    limit: coerceInt,
  })
  .refine(
    (data) => {
      if (data.minPrice !== undefined && data.maxPrice !== undefined) {
        return data.minPrice <= data.maxPrice;
      }
      return true;
    },
    { message: "minPrice cannot be greater than maxPrice", path: ["maxPrice"] },
  );
