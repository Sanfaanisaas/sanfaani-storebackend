import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import { catchAsync } from "../utils/catchAsync.js";

export const createProduct = catchAsync(async (req, res) => {
  const product = await Product.create(req.body);

  res.status(201).json({
    success: true,
    data: product,
  });
});

export const updateProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

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

  const products = await Product.find({ status: "active" })
    .skip(skip)
    .limit(limit)
    .sort("-createdAt")
    .lean();

  const productIds = products.map((p) => p._id);
  const allVariants = await Variant.find({ product: { $in: productIds } });

  const data = products.map((product) => {
    const variants = allVariants
      .filter((v) => v.product.toString() === product._id.toString())
      .map((v) => v.toPublicObject());
    return { ...product, variants };
  });

  const total = await Product.countDocuments({ status: "active" });

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
    status: "active",
  }).lean();

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  const variants = await Variant.find({ product: product._id });
  const publicVariants = variants.map((v) => v.toPublicObject());

  res.status(200).json({
    success: true,
    data: { ...product, variants: publicVariants },
  });
});
