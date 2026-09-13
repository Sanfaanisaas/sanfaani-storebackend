import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import { searchCatalogue } from "../services/catalogueSearchService.js";
import { searchProductsSchema } from "../utils/validators/productSearchValidators.js";
import {
  normalizeSlug,
  publicationErrorBody,
  validatePublicationCandidate,
} from "../services/catalogueValidationService.js";
import { catchAsync } from "../utils/catchAsync.js";
import { PRODUCT_STATUS } from "../utils/constants.js";
import { projectProductPublic } from "../utils/projections.js";

const slugIsUnique = (excludedProductId) => async (slug) => {
  if (!slug) return false;

  const query = { slug };
  if (excludedProductId) query._id = { $ne: excludedProductId };
  return !(await Product.exists(query));
};

export const createProduct = catchAsync(async (req, res) => {
  const candidate = {
    ...req.body,
    ...(req.body.slug != null ? { slug: normalizeSlug(req.body.slug) } : {}),
  };

  if (candidate.status === PRODUCT_STATUS.ACTIVE) {
    const missing = await validatePublicationCandidate({
      product: candidate,
      variants: [],
      isSlugUnique: slugIsUnique(),
    });

    if (missing.length > 0) {
      return res.status(422).json(publicationErrorBody(missing));
    }
  }

  const product = await Product.create(candidate);

  return res.status(201).json({
    success: true,
    data: product,
  });
});

export const updateProduct = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  const proposed = {
    ...req.body,
    ...(req.body.slug != null ? { slug: normalizeSlug(req.body.slug) } : {}),
  };
  const candidate = { ...product.toObject(), ...proposed };

  if (candidate.status === PRODUCT_STATUS.ACTIVE) {
    const variants = await Variant.find({ product: product._id });
    const missing = await validatePublicationCandidate({
      product: candidate,
      variants,
      isSlugUnique: slugIsUnique(product._id),
    });

    if (missing.length > 0) {
      return res.status(422).json(publicationErrorBody(missing));
    }
  }

  Object.assign(product, proposed);
  await product.save();

  return res.status(200).json({
    success: true,
    data: product,
  });
});

export const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { status: PRODUCT_STATUS.ARCHIVED },
    { new: true },
  );

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  return res.status(200).json({
    success: true,
    data: { message: "Product archived successfully" },
  });
});

export const listProducts = catchAsync(async (req, res) => {
  // 1. Natively validate the query parameters using Zod
  const validation = searchProductsSchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(422).json({
      success: false,
      message: "Invalid search parameters",
      // Safely access Zod's issues array and fallback to empty array
      errors: (validation.error?.issues || []).map((err) => ({
        code: "invalid_query_parameter",
        path: Array.isArray(err.path) ? err.path.join(".") : "",
        message: err.message,
      })),
    });
  }

  // 2. Fetch the aggregated catalogue data
  const result = await searchCatalogue(req.query);

  // 3. Project the data securely for public consumption
  const data = (result.products || []).map((product) =>
    projectProductPublic(product, product.variants || []),
  );

  return res.status(200).json({
    success: true,
    data: {
      products: data,
      pagination: result.pagination,
    },
  });
});

export const getProductDetail = catchAsync(async (req, res) => {
  const product = await Product.findOne({
    slug: normalizeSlug(req.params.slug),
    status: PRODUCT_STATUS.ACTIVE,
  }).lean();

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  const variants = await Variant.find({ product: product._id }).lean();

  return res.status(200).json({
    success: true,
    data: projectProductPublic(product, variants),
  });
});
