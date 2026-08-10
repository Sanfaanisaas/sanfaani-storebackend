import mongoose from "mongoose";
import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import { catchAsync } from "../utils/catchAsync.js";
import { PRODUCT_STATUS } from "../utils/constants.js";

const getPublicProduct = (product, variants) => {
  const { __v, ...rest } = product instanceof mongoose.Model ? product.toObject() : product;
  return {
    ...rest,
    variants: variants.map(v => v instanceof mongoose.Model ? v.toPublicObject() : v)
  };
};

export const createProduct = catchAsync(async (req, res) => {
  const product = await Product.create(req.body);

  res.status(201).json({
    success: true,
    data: product,
  });
});

export const updateProduct = catchAsync(async (req, res) => {
  const { status } = req.body;

  let product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  // Enforce publication rules
  if (status === PRODUCT_STATUS.ACTIVE && product.status !== PRODUCT_STATUS.ACTIVE) {
    const variants = await Variant.find({ product: product._id });
    const errors = [];

    if (!product.name) errors.push("Name is required");
    if (!product.slug) errors.push("Slug is required");
    if (!product.description) errors.push("Description is required");
    if (!product.category) errors.push("Category is required");
    if (!product.brand) errors.push("Brand is required");
    if (!product.images || product.images.length === 0) errors.push("At least one image is required");
    if (variants.length === 0) errors.push("At least one variant is required");

    for (const v of variants) {
      if (!v.sku) errors.push(`Variant ${v._id}: SKU is required`);
      if (v.price == null) errors.push(`Variant ${v._id}: Price is required`);
      if (!v.condition) errors.push(`Variant ${v._id}: Condition is required`);
      if (v.inStock == null && !v.sourcing) errors.push(`Variant ${v._id}: Valid inventory mode is required`);
    }

    if (errors.length > 0) {
      return res.status(422).json({
        success: false,
        message: "Publication requirements not met",
        errors
      });
    }
  }

  Object.assign(product, req.body);
  await product.save();

  res.status(200).json({
    success: true,
    data: product,
  });
});

export const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { status: "archived" },
    { new: true }
  );

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  res.status(200).json({
    success: true,
    data: { message: "Product archived successfully" },
  });
});

export const listProducts = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = (page - 1) * limit;

  const products = await Product.find({ status: PRODUCT_STATUS.ACTIVE })
    .skip(skip)
    .limit(limit)
    .sort("-createdAt")
    .lean();

  const productIds = products.map((p) => p._id);
  const allVariants = await Variant.find({ product: { $in: productIds } });

  const variantsByProduct = allVariants.reduce((acc, v) => {
    const productId = v.product?.toString();
    if (!productId) return acc;
    (acc[productId] ??= []).push(v);
    return acc;
  }, {});

  const data = products.map((product) => 
    getPublicProduct(product, variantsByProduct[product._id.toString()] ?? [])
  );

  const total = await Product.countDocuments({ status: PRODUCT_STATUS.ACTIVE });

  res.status(200).json({
    success: true,
    data: {
      products: data,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    },
  });
});

export const getProductDetail = catchAsync(async (req, res) => {
  const product = await Product.findOne({
    slug: req.params.slug,
    status: PRODUCT_STATUS.ACTIVE,
  }).lean();

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  const variants = await Variant.find({ product: product._id });

  res.status(200).json({
    success: true,
    data: getPublicProduct(product, variants),
  });
});
