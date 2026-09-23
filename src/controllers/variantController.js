import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import {
  publicationErrorBody,
  validatePublicationCandidate,
} from "../services/catalogueValidationService.js";
import { catchAsync } from "../utils/catchAsync.js";
import { PRODUCT_STATUS } from "../utils/constants.js";
import { projectVariantPublic } from "../utils/projections.js";

const slugIsUnique = (productId) => async (slug) => !await Product.exists({
  slug,
  _id: { $ne: productId },
});

export const createVariant = catchAsync(async (req, res) => {
  const product = await Product.findOne({ _id: { $eq: req.body.product } });
  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      errors: null,
    });
  }

  if (product.status === PRODUCT_STATUS.ACTIVE) {
    const currentVariants = await Variant.find({ product: product._id });
    const missing = await validatePublicationCandidate({
      product,
      variants: [...currentVariants, req.body],
      isSlugUnique: slugIsUnique(product._id),
    });

    if (missing.length > 0) {
      return res.status(422).json(publicationErrorBody(missing));
    }
  }

  const variant = await Variant.create(req.body);

  return res.status(201).json({
    success: true,
    data: projectVariantPublic(variant),
  });
});

export const updateVariant = catchAsync(async (req, res) => {
  const variant = await Variant.findOne({ _id: { $eq: req.params.id } });

  if (!variant) {
    return res.status(404).json({
      success: false,
      message: "Variant not found",
      errors: null,
    });
  }

  if (req.body.product
      && req.body.product.toString() !== variant.product.toString()) {
    return res.status(400).json({
      success: false,
      message: "Variant ownership cannot be moved",
      errors: [{ field: "product", code: "ownership_mismatch" }],
    });
  }

  const product = await Product.findById(variant.product);
  const proposed = { ...req.body };
  delete proposed.product;
  const candidateVariant = { ...variant.toObject(), ...proposed };

  if (product?.status === PRODUCT_STATUS.ACTIVE) {
    const currentVariants = await Variant.find({ product: product._id });
    const aggregateVariants = currentVariants.map((current) => (
      current._id.equals(variant._id) ? candidateVariant : current
    ));
    const missing = await validatePublicationCandidate({
      product,
      variants: aggregateVariants,
      isSlugUnique: slugIsUnique(product._id),
    });

    if (missing.length > 0) {
      return res.status(422).json(publicationErrorBody(missing));
    }
  }

  Object.assign(variant, proposed);
  await variant.save();

  return res.status(200).json({
    success: true,
    data: projectVariantPublic(variant),
  });
});
