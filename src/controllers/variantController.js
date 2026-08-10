import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import { catchAsync } from "../utils/catchAsync.js";

export const createVariant = catchAsync(async (req, res) => {
  const { product: productId } = req.body;

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  const variant = await Variant.create(req.body);

  res.status(201).json({
    success: true,
    data: variant,
  });
});

export const updateVariant = catchAsync(async (req, res) => {
  const { product: productId } = req.body;
  
  let variant = await Variant.findById(req.params.id);

  if (!variant) {
    return res.status(404).json({
      success: false,
      message: "Variant not found",
      errors: null,
    });
  }

  // Prevent ownership transfer
  if (productId && productId.toString() !== variant.product.toString()) {
    return res.status(400).json({
      success: false,
      message: "Variant ownership cannot be moved",
    });
  }

  // Update variant
  Object.assign(variant, req.body);
  await variant.save();

  res.status(200).json({
    success: true,
    data: variant,
  });
});
