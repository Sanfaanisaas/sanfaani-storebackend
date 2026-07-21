import { Router } from "express";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  getProductDetail,
} from "../controllers/productController.js";
import {
  createVariant,
  updateVariant,
} from "../controllers/variantController.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
} from "../utils/validators/productValidators.js";

const router = Router();

// Public routes
/**
 * @swagger
 * /products:
 *   get:
 *     summary: List active products
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of products with public variants
 */
router.get("/", listProducts);

/**
 * @swagger
 * /products/{slug}:
 *   get:
 *     summary: Get product detail by slug
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product detail with public variants
 *       404:
 *         description: Product not found
 */
router.get("/:slug", getProductDetail);

// Admin routes
/**
 * @swagger
 * /products:
 *   post:
 *     summary: Create a new product (Admin only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateProduct'
 *     responses:
 *       201:
 *         description: Product created
 *       403:
 *         description: Not authorized
 */
router.post(
  "/",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(createProductSchema),
  createProduct
);

/**
 * @swagger
 * /products/{id}:
 *   patch:
 *     summary: Update a product (Admin only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product updated
 */
router.patch(
  "/:id",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(updateProductSchema),
  updateProduct
);

/**
 * @swagger
 * /products/{id}:
 *   delete:
 *     summary: Soft delete (archive) a product (Admin only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product archived
 */
router.delete(
  "/:id",
  authenticate,
  authorize("product_admin", "super_admin"),
  deleteProduct
);

/**
 * @swagger
 * /products/variants:
 *   post:
 *     summary: Create a new variant (Admin only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Variant created
 */
router.post(
  "/variants",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(createVariantSchema),
  createVariant
);

/**
 * @swagger
 * /products/variants/{id}:
 *   patch:
 *     summary: Update a variant (Admin only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Variant updated
 */
router.patch(
  "/variants/:id",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(updateVariantSchema),
  updateVariant
);

export default router;
