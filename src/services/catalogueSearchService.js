import Product from "../models/Product.js";
import {
  PRODUCT_STATUS,
  LOW_STOCK_THRESHOLD,
  AVAILABILITY_STATUS,
} from "../utils/constants.js";

export const searchCatalogue = async (queryOptions) => {
  const { q, category, brand, condition, availability, sort } = queryOptions;

  // Safely parse numbers natively to protect the Mongo Aggregation Pipeline
  const minPrice =
    queryOptions.minPrice !== undefined && queryOptions.minPrice !== ""
      ? Number(queryOptions.minPrice)
      : undefined;
  const maxPrice =
    queryOptions.maxPrice !== undefined && queryOptions.maxPrice !== ""
      ? Number(queryOptions.maxPrice)
      : undefined;

  const page = queryOptions.page ? Math.max(1, Number(queryOptions.page)) : 1;
  const limit = queryOptions.limit
    ? Math.min(Math.max(1, Number(queryOptions.limit)), 100)
    : 10;
  const skip = (page - 1) * limit;

  const pipeline = [];

  // 1. Text Search MUST be the very first stage if provided
  if (q) {
    pipeline.push({ $match: { $text: { $search: q } } });
    pipeline.push({ $addFields: { score: { $meta: "textScore" } } });
  }

  // 2. Product-level constraints
  const productMatch = { status: PRODUCT_STATUS.ACTIVE };
  if (category) productMatch.category = category;
  if (brand) productMatch.brand = brand;
  pipeline.push({ $match: productMatch });

  // 3. Join Variants
  pipeline.push({
    $lookup: {
      from: "variants",
      localField: "_id",
      foreignField: "product",
      as: "variants",
    },
  });

  // 4. Variant-level constraints
  const variantMatch = {};

  if (minPrice !== undefined || maxPrice !== undefined) {
    variantMatch.price = {};
    if (minPrice !== undefined && !isNaN(minPrice))
      variantMatch.price.$gte = minPrice;
    if (maxPrice !== undefined && !isNaN(maxPrice))
      variantMatch.price.$lte = maxPrice;
  }

  if (condition) variantMatch.condition = condition;

  if (availability) {
    if (
      availability === AVAILABILITY_STATUS.SOURCING ||
      availability === "sourcing"
    ) {
      variantMatch.sourcing = { $ne: null, $exists: true };
    } else if (
      availability === AVAILABILITY_STATUS.OUT_OF_STOCK ||
      availability === "out_of_stock"
    ) {
      variantMatch.$or = [
        { inStock: { $lte: 0 } },
        { inStock: { $exists: false }, sourcing: { $exists: false } },
        { inStock: null, sourcing: null },
      ];
    } else if (
      availability === AVAILABILITY_STATUS.LOW_STOCK ||
      availability === "low_stock"
    ) {
      variantMatch.inStock = { $gt: 0, $lte: LOW_STOCK_THRESHOLD || 5 };
    } else if (
      availability === AVAILABILITY_STATUS.IN_STOCK ||
      availability === "in_stock"
    ) {
      variantMatch.inStock = { $gt: LOW_STOCK_THRESHOLD || 5 };
    }
  }

  if (Object.keys(variantMatch).length > 0) {
    pipeline.push({
      $match: { variants: { $elemMatch: variantMatch } },
    });
  }

  // 5. Calculate sorting price (minimum price among all attached variants)
  pipeline.push({
    $addFields: { sortPrice: { $min: "$variants.price" } },
  });

  // 6. Sorting configuration
  let sortStage = {};
  if (sort === "price_asc") sortStage = { sortPrice: 1, _id: 1 };
  else if (sort === "price_desc") sortStage = { sortPrice: -1, _id: 1 };
  else if (sort === "newest") sortStage = { createdAt: -1, _id: 1 };
  else if (q) sortStage = { score: { $meta: "textScore" }, _id: 1 };
  else sortStage = { createdAt: -1, _id: 1 };

  pipeline.push({ $sort: sortStage });

  // 7. Execute Facet for parallel total count and paginated data
  pipeline.push({
    $facet: {
      metadata: [{ $count: "total" }],
      data: [{ $skip: skip }, { $limit: limit }],
    },
  });

  const [result] = await Product.aggregate(pipeline);
  const total = result?.metadata?.[0]?.total || 0;

  return {
    products: result?.data || [],
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  };
};
