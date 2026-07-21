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
  const variant = await Variant.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!variant) {
    return res.status(404).json({
      success: false,
      message: "Variant not found",
      errors: null,
    });
  }

  res.status(200).json({
    success: true,
    data: variant,
  });
});
