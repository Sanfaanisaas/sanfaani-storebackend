import { PRODUCT_CONDITION } from "../utils/constants.js";

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const finiteNonNegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const validHttpUrl = (value) => {
  if (!nonEmptyString(value)) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const normalizeSlug = (value) => {
  if (typeof value !== "string") return "";

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const requirement = (code, path, message, variant) => ({
  code,
  path,
  message,
  ...(variant?._id ? { variantId: variant._id.toString() } : {}),
  ...(nonEmptyString(variant?.sku) ? { sku: variant.sku.trim() } : {}),
});

/**
 * Validate a complete Product aggregate before it can be public.
 *
 * `isSlugUnique` is injected so API and migration callers use the same rules
 * without coupling this service to a database connection.
 */
export const validatePublicationCandidate = async ({
  product,
  variants = [],
  isSlugUnique = async () => true,
}) => {
  const missing = [];

  if (!nonEmptyString(product?.name)) {
    missing.push(requirement("product.name.required", "name", "Product name is required"));
  }

  const normalizedSlug = normalizeSlug(product?.slug);
  if (!nonEmptyString(product?.slug)) {
    missing.push(requirement("product.slug.required", "slug", "Product slug is required"));
  } else if (product.slug !== normalizedSlug) {
    missing.push(requirement(
      "product.slug.not_normalized",
      "slug",
      "Product slug must be normalized lowercase URL text",
    ));
  } else if (!(await isSlugUnique(normalizedSlug, product))) {
    missing.push(requirement(
      "product.slug.not_unique",
      "slug",
      "Product slug must be unique",
    ));
  }

  for (const [field, label] of [
    ["description", "description"],
    ["category", "category"],
    ["brand", "brand"],
  ]) {
    if (!nonEmptyString(product?.[field])) {
      missing.push(requirement(
        `product.${field}.required`,
        field,
        `Product ${label} is required`,
      ));
    }
  }

  if (!Array.isArray(product?.images)
      || !product.images.some((image) => nonEmptyString(image))) {
    missing.push(requirement(
      "product.images.required",
      "images",
      "At least one product image is required",
    ));
  }

  if (!Array.isArray(variants) || variants.length === 0) {
    missing.push(requirement(
      "product.variants.required",
      "variants",
      "At least one owned variant is required",
    ));
    return missing;
  }

  variants.forEach((variant, index) => {
    const root = `variants.${index}`;

    if (!nonEmptyString(variant?.sku)) {
      missing.push(requirement(
        "variant.sku.required",
        `${root}.sku`,
        "Variant SKU is required",
        variant,
      ));
    }

    if (!finiteNonNegative(variant?.price)) {
      missing.push(requirement(
        "variant.price.invalid",
        `${root}.price`,
        "Variant price must be a finite non-negative number",
        variant,
      ));
    }

    if (!Object.values(PRODUCT_CONDITION).includes(variant?.condition)) {
      missing.push(requirement(
        "variant.condition.invalid",
        `${root}.condition`,
        "Variant condition must be a supported catalogue condition",
        variant,
      ));
    }

    const hasSourcing = variant?.sourcing != null;
    const hasValidSourcing = hasSourcing
      && nonEmptyString(variant.sourcing.supplier)
      && finiteNonNegative(variant.sourcing.leadTimeDays)
      && finiteNonNegative(variant.sourcing.costPrice);
    const hasValidLocalStock = finiteNonNegative(variant?.inStock);
    const hasAnyLocalStock = variant?.inStock != null;

    if ((hasSourcing && hasAnyLocalStock) || (!hasSourcing && !hasValidLocalStock)
        || (hasSourcing && !hasValidSourcing)) {
      missing.push(requirement(
        "variant.inventory_mode.invalid",
        `${root}.inventoryMode`,
        "Variant must have exactly one valid inventory mode: sourcing or finite non-negative inStock",
        variant,
      ));
    }

    if (!nonEmptyString(variant?.inspection?.summary)) {
      missing.push(requirement(
        "variant.inspection.summary.required",
        `${root}.inspection.summary`,
        "Variant inspection summary is required",
        variant,
      ));
    }

    const inspectedAt = variant?.inspection?.inspectedAt;
    if (inspectedAt != null && Number.isNaN(new Date(inspectedAt).getTime())) {
      missing.push(requirement(
        "variant.inspection.inspected_at.invalid",
        `${root}.inspection.inspectedAt`,
        "Inspection date must be a valid date-time when provided",
        variant,
      ));
    }

    const hasConditionEvidence = Array.isArray(variant?.conditionEvidence)
      && variant.conditionEvidence.length > 0
      && variant.conditionEvidence.every((evidence) => (
        evidence
          && typeof evidence === "object"
          && validHttpUrl(evidence.url)
          && (evidence.alt == null || typeof evidence.alt === "string")
      ));
    if (!hasConditionEvidence) {
      missing.push(requirement(
        "variant.condition_evidence.required",
        `${root}.conditionEvidence`,
        "At least one structured condition-evidence item is required",
        variant,
      ));
    }

    if (!nonEmptyString(variant?.limitations)) {
      missing.push(requirement(
        "variant.limitations.required",
        `${root}.limitations`,
        "Known limitations must be stated explicitly; use 'None' when applicable",
        variant,
      ));
    }

    if (!nonEmptyString(variant?.warranty?.version)) {
      missing.push(requirement(
        "variant.warranty.version.required",
        `${root}.warranty.version`,
        "Warranty version is required",
        variant,
      ));
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(variant.warranty.version)) {
      missing.push(requirement(
        "variant.warranty.version.invalid",
        `${root}.warranty.version`,
        "Warranty version must use the controlled version identifier format",
        variant,
      ));
    }

    if (!nonEmptyString(variant?.warranty?.terms)) {
      missing.push(requirement(
        "variant.warranty.terms.required",
        `${root}.warranty.terms`,
        "Warranty terms are required",
        variant,
      ));
    }
  });

  return missing;
};

export const publicationErrorBody = (missing) => ({
  success: false,
  message: "Publication requirements not met",
  errors: missing,
});
