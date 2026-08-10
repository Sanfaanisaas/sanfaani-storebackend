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
  createVariantSchemaWithRefinement,
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     products:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/PublicProduct' }
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/PublicProduct' }
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
 *             type: object
 *             properties:
 *               name: { type: string }
 *               slug: { type: string }
 *               description: { type: string }
 *               category: { type: string }
 *               brand: { type: string }
 *               images: { type: array, items: { type: string } }
 *               status: { type: string, enum: [draft, active, archived] }
 *     responses:
 *       201:
 *         description: Product created
 *       409:
 *         description: Product slug already exists
 *       422:
 *         description: Direct publication failed aggregate validation
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PublicationError' }
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
 *       422:
 *         description: Candidate aggregate does not meet publication requirements
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PublicationError' }
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CatalogueVariantInput' }
 *     responses:
 *       201:
 *         description: Variant created
 *       409:
 *         description: Variant SKU already exists
 *       422:
 *         description: Variant would make an active aggregate unpublishable
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PublicationError' }
 */
router.post(
  "/variants",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(createVariantSchemaWithRefinement),
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
 *       422:
 *         description: Candidate active aggregate is not publishable
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PublicationError' }
 */
router.patch(
  "/variants/:id",
  authenticate,
  authorize("product_admin", "super_admin"),
  validate(updateVariantSchema),
  updateVariant
);

export default router;
