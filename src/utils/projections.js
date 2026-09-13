import { AVAILABILITY_STATUS, LOW_STOCK_THRESHOLD } from "./constants.js";

const INTERNAL_PROCUREMENT_KEYS = new Set([
  "costprice",
  "cost_price",
  "internalprocurement",
  "procurement",
  "procurementnotes",
  "purchaseorder",
  "sourcing",
  "supplier",
  "supplierid",
]);

const sanitizePublicValue = (value) => {
  if (Array.isArray(value)) return value.map(sanitizePublicValue);
  if (
    !value ||
    typeof value !== "object" ||
    value instanceof Date ||
    value._bsontype
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !INTERNAL_PROCUREMENT_KEYS.has(key.toLowerCase()))
      .map(([key, nested]) => [key, sanitizePublicValue(nested)]),
  );
};

const copyDefined = (source, fields) =>
  Object.fromEntries(
    fields
      .filter((field) => source?.[field] !== undefined)
      .map((field) => [field, sanitizePublicValue(source[field])]),
  );

// Safely handle both Mongoose Documents (from basic controllers) and POJOs (from Aggregation Pipelines)
const documentObject = (value) =>
  value?.toObject ? value.toObject({ virtuals: false }) : value;

export const deriveAvailability = (variant) => {
  if (variant?.sourcing != null) return AVAILABILITY_STATUS.SOURCING;
  if (!Number.isFinite(variant?.inStock) || variant.inStock < 0) {
    return AVAILABILITY_STATUS.OUT_OF_STOCK;
  }
  if (variant.inStock === 0) return AVAILABILITY_STATUS.OUT_OF_STOCK;
  if (variant.inStock <= LOW_STOCK_THRESHOLD)
    return AVAILABILITY_STATUS.LOW_STOCK;
  return AVAILABILITY_STATUS.IN_STOCK;
};

const PRODUCT_PUBLIC_FIELDS = Object.freeze([
  "name",
  "slug",
  "description",
  "category",
  "brand",
  "images",
  "tags",
  "isFeatured",
  "seo",
]);

const VARIANT_PUBLIC_FIELDS = Object.freeze([
  "sku",
  "attributes",
  "price",
  "condition",
  "inspection",
  "limitations",
  "conditionEvidence",
  "warranty",
]);

export const projectVariantPublic = (variant) => {
  const source = documentObject(variant) ?? {};
  const projected = copyDefined(source, VARIANT_PUBLIC_FIELDS);

  // Safely extract string IDs from both Document _id and POJO _id objects
  if (source._id != null) projected.id = source._id.toString();
  projected.availability = deriveAvailability(source);

  return projected;
};

export const projectProductPublic = (product, variants = []) => {
  const source = documentObject(product) ?? {};
  const projected = copyDefined(source, PRODUCT_PUBLIC_FIELDS);

  if (source._id != null) projected.id = source._id.toString();
  projected.variants = variants.map(projectVariantPublic);

  return projected;
};
